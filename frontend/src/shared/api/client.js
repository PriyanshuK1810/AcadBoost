import { PRODUCT_BRAND } from '../../app/brand'

/** One API transport for every feature. The access token stays in memory. */
export class ApiRequestError extends Error {
  status
  constructor(message, status, { code, request_id, details } = {}) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.request_id = request_id
    this.details = details
  }
}
const baseUrl = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(
  /\/$/,
  '',
)
let accessToken = null
let accountId = null
let generation = 0
let refresh = null
let restoration = null
let logout = null
let logoutBearer = null
let cookieAccountId = null
const logoutKey = 'acadboost:pending-sign-out'
const listeners = new Set()

function readLogoutIntent() {
  try {
    const stored = window.sessionStorage.getItem(logoutKey)
    if (stored === 'current' || stored === 'all') return { scope: stored }
    const intent = JSON.parse(stored)
    return intent?.scope === 'current' || intent?.scope === 'all'
      ? intent
      : null
  } catch {
    return null
  }
}

function rememberLogout(intent) {
  try {
    if (intent) window.sessionStorage.setItem(logoutKey, JSON.stringify(intent))
    else window.sessionStorage.removeItem(logoutKey)
  } catch {
    // The in-memory guard still applies when tab storage is unavailable.
  }
}

const savedLogout = readLogoutIntent()
let logoutScope = savedLogout?.scope ?? null
let logoutAccountId =
  typeof savedLogout?.accountId === 'string' ? savedLogout.accountId : null
let phase = logoutScope ? 'logout-failed' : 'idle'

export function getSessionPhase() {
  return phase
}

export function subscribeSession(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(next) {
  if (phase === next) return
  phase = next
  for (const listener of listeners) listener()
}

export function canRestoreSession() {
  return phase === 'active' || phase === 'idle'
}

function invalidate(next) {
  generation += 1
  accessToken = null
  accountId = null
  publish(next)
}

const channel =
  typeof window.BroadcastChannel === 'function'
    ? new window.BroadcastChannel('acadboost-session')
    : null
channel?.addEventListener('message', (event) => {
  const message = event.data
  if (typeof message?.accountId !== 'string' || !message.accountId) return
  if (message.type === 'signed-in') {
    cookieAccountId = message.accountId
    return
  }
  if (message.type !== 'signed-out') return
  restoration?.signedOutAccounts.add(message.accountId)
  if (
    (accountId === message.accountId && canRestoreSession()) ||
    (phase === 'logout-failed' &&
      logoutAccountId === message.accountId &&
      message.scope === 'all')
  ) {
    logoutScope = null
    logoutBearer = null
    logoutAccountId = null
    rememberLogout(null)
    invalidate('signed-out')
  }
  if (cookieAccountId === message.accountId) cookieAccountId = null
})

export function hasAccessToken() {
  return accessToken !== null
}
export function setAccessToken(token) {
  generation += 1
  accessToken = token
  accountId = null
  publish(token ? 'active' : 'idle')
}
export function clearAccessToken() {
  logoutScope = null
  logoutBearer = null
  logoutAccountId = null
  cookieAccountId = null
  rememberLogout(null)
  invalidate('idle')
}

async function request(
  path,
  options = {},
  token = accessToken,
  expectedStatus,
) {
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      credentials: options.credentials ?? 'include',
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch {
    throw new Error(
      `Unable to reach ${PRODUCT_BRAND}. Check that the API is running and try again.`,
    )
  }
  if (!response.ok) {
    let error
    try {
      const payload = await response.json()
      error = payload?.error
    } catch {
      // Some API errors intentionally have no JSON body.
    }
    throw new ApiRequestError(
      error?.message || 'Something went wrong. Please try again.',
      response.status,
      error ?? undefined,
    )
  }
  if (expectedStatus && response.status !== expectedStatus) {
    throw new ApiRequestError(
      'The server did not confirm the session change.',
      response.status,
    )
  }
  if (response.status === 204 || response.status === 202) return undefined
  if (options.responseType === 'blob') return await response.blob()
  return await response.json()
}

function authPost(
  path,
  { token = null, body, expectedStatus, credentials } = {},
) {
  return request(
    path,
    { method: 'POST', body, credentials, signal: AbortSignal.timeout(15_000) },
    token,
    expectedStatus,
  )
}

// Refresh cookies are shared by tabs. Serialize their rotation where supported.
function withCookieLock(action) {
  return navigator.locks
    ? navigator.locks.request('acadboost-session', action)
    : action()
}

function sessionChanged() {
  return new ApiRequestError(
    'Your session has changed. Sign in again to continue.',
    401,
  )
}

async function refreshBearer(expectedAccount) {
  if (expectedAccount && cookieAccountId && expectedAccount !== cookieAccountId)
    throw sessionChanged()
  const result = await authPost('/auth/refresh')
  if (typeof result?.access_token !== 'string' || !result.access_token) {
    throw new Error('The server did not return an access credential.')
  }
  if (expectedAccount) {
    const user = await request(
      '/me',
      { signal: AbortSignal.timeout(15_000) },
      result.access_token,
    )
    if (user?.id !== expectedAccount) throw sessionChanged()
  }
  return result.access_token
}

async function refreshSession(started, previousToken) {
  if (started !== generation || !canRestoreSession()) throw sessionChanged()
  if (accessToken && accessToken !== previousToken) return accessToken
  if (!refresh) {
    const expectedAccount = accountId
    const operation = withCookieLock(() => {
      if (started !== generation || !canRestoreSession()) throw sessionChanged()
      return refreshBearer(expectedAccount)
    })
    refresh = operation
  }
  const operation = refresh
  try {
    const token = await operation
    if (started !== generation || !canRestoreSession()) throw sessionChanged()
    accessToken = token
    publish('active')
    return token
  } catch (error) {
    if (
      started === generation &&
      canRestoreSession() &&
      error.status === 401 &&
      previousToken
    ) {
      invalidate('expired')
    }
    throw error
  } finally {
    if (refresh === operation) refresh = null
  }
}

function requiresSession(path) {
  return (
    !path.startsWith('/auth/') ||
    path.startsWith('/auth/sessions') ||
    path === '/auth/email-verification/request'
  )
}

export async function apiRequest(path, options = {}) {
  const protectedRequest = requiresSession(path)
  if (protectedRequest && !canRestoreSession()) throw sessionChanged()
  const started = generation
  const token = accessToken
  function assertCurrent() {
    if (protectedRequest && started !== generation) throw sessionChanged()
  }
  try {
    const data = await request(path, options, token)
    assertCurrent()
    return data
  } catch (error) {
    assertCurrent()
    if (!protectedRequest || !token || error.status !== 401) throw error
    const renewed = await refreshSession(started, token)
    assertCurrent()
    if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
      throw new ApiRequestError(
        'Your session was refreshed. Please try this action again.',
        401,
      )
    }
    const data = await request(path, options, renewed)
    assertCurrent()
    return data
  }
}

export async function restoreAuthSession() {
  if (!canRestoreSession()) return null
  if (restoration?.generation === generation) return restoration.result
  const started = generation
  const signedOutAccounts = new Set()
  const result = (async () => {
    try {
      if (!accessToken) await refreshSession(started, null)
      if (started !== generation) return null
      const user = await apiRequest('/me')
      if (started !== generation || !canRestoreSession()) return null
      if (signedOutAccounts.has(user?.id)) {
        invalidate('signed-out')
        return null
      }
      accountId = user?.id ?? null
      return user
    } catch {
      return null
    }
  })()
  restoration = { generation: started, result, signedOutAccounts }
  try {
    return await result
  } finally {
    if (restoration?.result === result) restoration = null
  }
}

export async function authenticateSession(path, input) {
  if (phase === 'signing-out' || phase === 'authenticating')
    throw sessionChanged()
  const priorRefresh = refresh
  const previous = phase
  const started = ++generation
  publish('authenticating')
  try {
    await priorRefresh?.catch(() => {})
    return await withCookieLock(async () => {
      if (started !== generation) throw sessionChanged()
      const result = await authPost(path, { body: JSON.stringify(input) })
      const token = result?.access_token
      if (typeof token !== 'string' || !token)
        throw new Error('The server did not return an access credential.')
      const user = await request(
        '/me',
        { signal: AbortSignal.timeout(15_000) },
        token,
      )
      if (started !== generation) throw sessionChanged()
      accessToken = token
      accountId = user?.id ?? null
      cookieAccountId = accountId
      logoutBearer = null
      logoutAccountId = null
      logoutScope = null
      rememberLogout(null)
      publish('active')
      if (accountId) channel?.postMessage({ type: 'signed-in', accountId })
      return user
    })
  } catch (error) {
    if (started === generation) publish(previous)
    throw error
  }
}

export function endAuthSession(scope) {
  if (logout) return logout
  if (phase === 'signed-out') return Promise.resolve()
  if (phase === 'authenticating') return Promise.reject(sessionChanged())
  const retrying = phase === 'logout-failed'
  logoutScope ??= scope ?? 'current'
  const path = logoutScope === 'all' ? '/auth/logout-all' : '/auth/logout'
  const priorRefresh = refresh
  logoutBearer ??= accessToken
  logoutAccountId ??= accountId
  rememberLogout({ scope: logoutScope, accountId: logoutAccountId })
  invalidate('signing-out')

  logout = (async () => {
    try {
      const rotated = await priorRefresh?.catch(() => null)
      if (rotated) logoutBearer = rotated
      await withCookieLock(async () => {
        if (logoutBearer) {
          try {
            // A still-valid older bearer can end its own session without clearing another account's cookie.
            const keepCookie =
              logoutAccountId &&
              cookieAccountId &&
              logoutAccountId !== cookieAccountId
            await authPost(path, {
              token: logoutBearer,
              expectedStatus: 204,
              credentials: keepCookie ? 'omit' : 'include',
            })
            return
          } catch (error) {
            if (error.status !== 401 || rotated) throw error
          }
        }
        if (retrying && !logoutAccountId) throw sessionChanged()
        logoutBearer = await refreshBearer(logoutAccountId)
        await authPost(path, { token: logoutBearer, expectedStatus: 204 })
      })
      const confirmed = {
        type: 'signed-out',
        accountId: logoutAccountId,
        scope: logoutScope,
      }
      if (cookieAccountId === logoutAccountId) cookieAccountId = null
      logoutBearer = null
      logoutAccountId = null
      logoutScope = null
      rememberLogout(null)
      publish('signed-out')
      if (confirmed.accountId) channel?.postMessage(confirmed)
    } catch (error) {
      publish('logout-failed')
      throw error
    } finally {
      logout = null
    }
  })()
  return logout
}
