import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  apiRequest,
  clearAccessToken,
  hasAccessToken,
  setAccessToken,
} from '../../shared/api/client'
import { restoreSession, signInWithPassword, signOut } from './authApi'

const response = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status })
const user = { id: 'user-1', account_type: 'coordinator' }
let calls
let reply

beforeEach(() => {
  clearAccessToken()
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url, options) => {
      const path = String(url).replace('/api/v1', '')
      calls.push([path, options.method ?? 'GET', options.headers.Authorization])
      return reply(path, options)
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

it('refreshes privately after logout rejects the expired bearer and waits for 204', async () => {
  setAccessToken('old')
  reply = (path, options) =>
    path === '/auth/refresh'
      ? response(200, { access_token: 'new' })
      : response(options.headers.Authorization === 'Bearer new' ? 204 : 401)

  await expect(signOut()).resolves.toBeUndefined()
  expect(calls).toEqual([
    ['/auth/logout', 'POST', 'Bearer old'],
    ['/auth/refresh', 'POST', undefined],
    ['/auth/logout', 'POST', 'Bearer new'],
  ])
  expect(hasAccessToken()).toBe(false)
  await expect(restoreSession()).resolves.toBeNull()
  expect(calls).toHaveLength(3)
})

it('uses a valid bearer once and does not restore the confirmed logout', async () => {
  setAccessToken('valid')
  reply = () => response(204)
  await signOut()
  await expect(restoreSession()).resolves.toBeNull()
  expect(calls).toEqual([['/auth/logout', 'POST', 'Bearer valid']])
})

it('uses the refresh cookie when no bearer is in memory', async () => {
  reply = (path) =>
    path === '/auth/refresh'
      ? response(200, { access_token: 'fresh' })
      : response(204)
  await signOut()
  expect(calls).toEqual([
    ['/auth/refresh', 'POST', undefined],
    ['/auth/logout', 'POST', 'Bearer fresh'],
  ])
})

it.each([401, 500, 202, 'network'])(
  'keeps an uncertain logout (%s) blocked until the user retries',
  async (status) => {
    setAccessToken('current')
    reply = (path) => {
      if (path === '/auth/refresh') return response(401)
      if (status === 'network') throw new TypeError('offline')
      return response(status)
    }
    await expect(signOut()).rejects.toThrow()
    const prior = calls.length
    await expect(restoreSession()).resolves.toBeNull()
    expect(calls).toHaveLength(prior)
    reply = () => response(204)
    await signOut()
    expect(calls.at(-1)).toEqual(['/auth/logout', 'POST', 'Bearer current'])
  },
)

it('shares a pending refresh with logout without accepting it or restoring the workspace', async () => {
  const delayed = Promise.withResolvers()
  const started = Promise.withResolvers()
  reply = (path) => {
    if (path === '/auth/refresh') {
      started.resolve()
      return delayed.promise
    }
    return response(path === '/auth/logout' ? 204 : 500)
  }
  const restoration = restoreSession()
  await started.promise
  const logout = signOut()
  const duplicate = signOut()
  await expect(restoreSession()).resolves.toBeNull()
  delayed.resolve(response(200, { access_token: 'rotated' }))
  await Promise.all([logout, duplicate])
  await expect(restoration).resolves.toBeNull()
  expect(calls).toEqual([
    ['/auth/refresh', 'POST', undefined],
    ['/auth/logout', 'POST', 'Bearer rotated'],
  ])
  expect(hasAccessToken()).toBe(false)
})

it('keeps a newer explicit sign-in when an older restoration resolves', async () => {
  setAccessToken('old')
  const delayed = Promise.withResolvers()
  reply = (path, options) => {
    if (path === '/auth/password/login')
      return response(200, { access_token: 'new' })
    return options.headers.Authorization === 'Bearer old'
      ? delayed.promise
      : response(200, user)
  }
  const old = restoreSession()
  await expect(
    signInWithPassword('fixture', 'sample-password'),
  ).resolves.toEqual(user)
  delayed.resolve(response(200, { id: 'obsolete' }))
  await expect(old).resolves.toBeNull()
  await expect(apiRequest('/me')).resolves.toEqual(user)
})

it('shares one refresh for concurrent reads and does not replay a write', async () => {
  setAccessToken('old')
  reply = (path, options) => {
    if (path === '/auth/refresh') return response(200, { access_token: 'new' })
    if (options.headers.Authorization === 'Bearer old') return response(401)
    return response(200, { ok: true })
  }
  const write = expect(
    apiRequest('/roadmaps', { method: 'POST' }),
  ).rejects.toThrow(/try this action again/i)
  await expect(
    Promise.all([apiRequest('/me'), apiRequest('/organizations')]),
  ).resolves.toEqual([{ ok: true }, { ok: true }])
  await write
  expect(calls.filter(([path]) => path === '/auth/refresh')).toHaveLength(1)
  expect(calls.filter(([path]) => path === '/roadmaps')).toHaveLength(1)
})

it('stops refreshing after a definitive rejection', async () => {
  setAccessToken('old')
  reply = () => response(401)
  await expect(apiRequest('/me')).rejects.toThrow()
  await expect(apiRequest('/organizations')).rejects.toThrow()
  expect(calls.filter(([path]) => path === '/auth/refresh')).toHaveLength(1)
  expect(hasAccessToken()).toBe(false)
})

it('does not use a refresh cookie for a different account to retry a request or revoke a session', async () => {
  setAccessToken('old')
  reply = () => response(200, user)
  await expect(restoreSession()).resolves.toEqual(user)
  reply = (path, options) => {
    if (path === '/auth/refresh')
      return response(200, { access_token: 'other' })
    if (path === '/me' && options.headers.Authorization === 'Bearer other') {
      return response(200, { ...user, id: 'other-user' })
    }
    return response(401)
  }

  await expect(signOut()).rejects.toThrow()
  expect(calls.filter(([path]) => path === '/auth/logout')).toEqual([
    ['/auth/logout', 'POST', 'Bearer old'],
  ])
  expect(hasAccessToken()).toBe(false)
})

it('ignores a failed older refresh and revokes with the still-valid bearer', async () => {
  const delayed = Promise.withResolvers()
  const started = Promise.withResolvers()
  setAccessToken('current')
  reply = (path) => {
    if (path === '/auth/refresh') {
      started.resolve()
      return delayed.promise
    }
    return response(path === '/auth/logout' ? 204 : 401)
  }
  const restoration = restoreSession()
  await started.promise
  const logout = signOut()
  delayed.resolve(response(500))
  await logout
  await expect(restoration).resolves.toBeNull()
  expect(calls.at(-1)).toEqual(['/auth/logout', 'POST', 'Bearer current'])
})

it('retains the account and scope across reload and never logs out a different account', async () => {
  setAccessToken('original')
  reply = (path) => (path === '/me' ? response(200, user) : response(503))
  await restoreSession()
  const { signOutAll } = await import('./authApi')
  await expect(signOutAll()).rejects.toThrow()

  vi.resetModules()
  const reloaded = await import('../../shared/api/client')
  try {
    expect(reloaded.getSessionPhase()).toBe('logout-failed')
    reply = (path) => {
      if (path === '/auth/refresh')
        return response(200, { access_token: 'other' })
      if (path === '/me') return response(200, { ...user, id: 'other-user' })
      return response(204)
    }
    await expect(reloaded.endAuthSession()).rejects.toThrow()
    expect(calls.filter(([path]) => path === '/auth/logout-all')).toEqual([
      ['/auth/logout-all', 'POST', 'Bearer original'],
    ])
    expect(reloaded.getSessionPhase()).toBe('logout-failed')
    reply = (path) => {
      if (path === '/auth/refresh')
        return response(200, { access_token: 'original-renewed' })
      if (path === '/me') return response(200, user)
      return response(204)
    }
    await reloaded.endAuthSession()
    expect(calls.at(-1)).toEqual([
      '/auth/logout-all',
      'POST',
      'Bearer original-renewed',
    ])
  } finally {
    reloaded.clearAccessToken()
  }
})

it('scopes logout notifications to the account and leaves pending sign-out-all unresolved after peer current-session logout', async () => {
  const channelListeners = new Map()
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      addEventListener(_type, listener) {
        channelListeners.set(this, listener)
      }
      postMessage(data) {
        for (const [channel, listener] of channelListeners) {
          if (channel !== this) listener({ data })
        }
      }
    },
  )
  const tabs = []
  try {
    for (const id of ['user-1', 'user-1', 'user-2']) {
      vi.resetModules()
      const tab = await import('../../shared/api/client')
      tabs.push(tab)
      tab.setAccessToken(id)
      reply = () => response(200, { ...user, id })
      await tab.restoreAuthSession()
    }
    const [pendingAll, signingOut, otherAccount] = tabs
    let logoutCredentials
    reply = (path, options) => {
      if (path === '/auth/logout-all') return response(503)
      if (path === '/auth/password/login')
        return response(200, { access_token: 'new-account' })
      if (path === '/me') return response(200, { ...user, id: 'user-2' })
      logoutCredentials = options.credentials
      return response(204)
    }
    await expect(pendingAll.endAuthSession('all')).rejects.toThrow()
    await otherAccount.authenticateSession('/auth/password/login', {})
    await signingOut.endAuthSession()
    expect(logoutCredentials).toBe('omit')
    expect(pendingAll.getSessionPhase()).toBe('logout-failed')
    expect(otherAccount.getSessionPhase()).toBe('active')
    expect(otherAccount.hasAccessToken()).toBe(true)
  } finally {
    for (const tab of tabs) tab.clearAccessToken()
  }
})
