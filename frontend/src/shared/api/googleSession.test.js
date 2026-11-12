import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as session from './client'

const response = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status })
const user = { id: 'google-user', account_type: 'student' }
const contextId = 'd95c59b8-2c0f-4f46-a84c-a41b0821c993'
let fetch

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_SIGN_IN_ENABLED', 'true')
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { locks: { request: (_key, action) => action() } })
  window.localStorage.clear()
  window.sessionStorage.clear()
  session.clearAccessToken()
  fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
  session.clearAccessToken()
})

async function startGoogle() {
  fetch
    .mockResolvedValueOnce(response(200, { context_id: contextId }))
    .mockResolvedValueOnce(response(204))
  const url = new URL(
    await session.beginGoogleSignIn(),
    'https://app.example.test',
  )
  const attempt = url.searchParams.get('attempt')
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    '/api/v1/auth/browser-context',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: '{}',
      headers: expect.objectContaining({ 'X-Acadboost-Browser-Auth': '1' }),
    }),
  )
  expect(fetch).toHaveBeenNthCalledWith(
    2,
    '/api/v1/auth/google/intent',
    expect.objectContaining({
      body: JSON.stringify({ context_id: contextId, attempt }),
    }),
  )
  fetch.mockClear()
  return url
}

it('starts a first-party attempt and activates only once through explicit refresh and /me', async () => {
  expect(session.canStartGoogleSignIn()).toBe(true)
  const url = await startGoogle()
  const attempt = url.searchParams.get('attempt')
  expect(url.pathname).toBe('/api/v1/auth/google/authorize')
  expect(attempt).toMatch(/^[\w-]{36}$/)
  fetch
    .mockResolvedValueOnce(response(200, { access_token: 'google-bearer' }))
    .mockResolvedValueOnce(response(200, user))
  await expect(
    Promise.all([
      session.completeGoogleSignIn(),
      session.completeGoogleSignIn(),
    ]),
  ).resolves.toEqual([user, user])
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    '/api/v1/auth/refresh',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Acadboost-Google-Attempt': attempt },
    }),
  )
  expect(fetch).toHaveBeenNthCalledWith(
    2,
    '/api/v1/me',
    expect.objectContaining({
      headers: { Authorization: 'Bearer google-bearer' },
    }),
  )
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_intent_stale',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('never posts an attempt superseded by another tab or by password sign-in', async () => {
  await startGoogle()
  window.localStorage.clear()
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_intent_stale',
  })
  expect(fetch).not.toHaveBeenCalled()
  await startGoogle()
  fetch
    .mockResolvedValueOnce(response(200, { access_token: 'password' }))
    .mockResolvedValueOnce(response(200, { id: 'password-user' }))
  await session.authenticateSession('/auth/password/login', {})
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    '/api/v1/auth/password/login',
    expect.objectContaining({
      headers: expect.objectContaining({
        'X-Acadboost-Auth-Intent': expect.stringMatching(/^[\w-]{36}$/),
      }),
    }),
  )
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_intent_stale',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('discards a superseded response without replaying activation or sending an unbound logout', async () => {
  await startGoogle()
  const activation = Promise.withResolvers()
  const sent = Promise.withResolvers()
  fetch.mockImplementationOnce(() => {
    sent.resolve()
    return activation.promise
  })
  const result = session.completeGoogleSignIn()
  const rejected = expect(result).rejects.toMatchObject({
    code: 'google_intent_stale',
  })
  await sent.promise
  window.localStorage.clear()
  activation.resolve(response(200, { access_token: 'just-issued' }))
  await rejected
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(session.hasAccessToken()).toBe(false)
})

it('blocks restore and repeat activation after a lost response', async () => {
  await startGoogle()
  fetch.mockRejectedValueOnce(new TypeError('network'))
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_activation_uncertain',
  })
  await expect(session.restoreAuthSession()).resolves.toBeNull()
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_intent_stale',
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('sends a current-context sign-out intent before trying to restore a cookie', async () => {
  await startGoogle()
  fetch.mockResolvedValueOnce(response(204))
  await expect(session.endAuthSession()).resolves.toBeUndefined()
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/v1/auth/logout',
    expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({
        'X-Acadboost-Auth-Intent': expect.stringMatching(/^[\w-]{36}$/),
      }),
    }),
  )
})

it('reuses the same explicit action after an uncertain logout response', async () => {
  await startGoogle()
  const activation = fetch.mockRejectedValueOnce(
    new TypeError('activation response lost'),
  )
  await expect(session.completeGoogleSignIn()).rejects.toMatchObject({
    code: 'google_activation_uncertain',
  })
  activation
    .mockClear()
    .mockRejectedValueOnce(new TypeError('logout response lost'))
    .mockResolvedValueOnce(response(204))
  await expect(session.endAuthSession()).rejects.toThrow()
  await expect(session.endAuthSession()).resolves.toBeUndefined()
  const actions = fetch.mock.calls.map(
    ([, options]) => options.headers['X-Acadboost-Auth-Intent'],
  )
  expect(actions).toHaveLength(2)
  expect(actions[0]).toMatch(/^[\w-]{36}$/)
  expect(actions[1]).toBe(actions[0])
})

it('uses a fresh action for a logout denied before same-account refresh', async () => {
  session.setAccessToken('expired')
  fetch
    .mockResolvedValueOnce(response(401))
    .mockResolvedValueOnce(response(200, { access_token: 'renewed' }))
    .mockResolvedValueOnce(response(204))
  await session.endAuthSession()
  const [first, , last] = fetch.mock.calls
  expect(first[0]).toBe('/api/v1/auth/logout')
  expect(last[0]).toBe('/api/v1/auth/logout')
  expect(last[1].headers['X-Acadboost-Auth-Intent']).not.toBe(
    first[1].headers['X-Acadboost-Auth-Intent'],
  )
})
