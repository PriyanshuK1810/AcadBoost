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
export function hasAccessToken() {
  return accessToken !== null
}
export function setAccessToken(token) {
  accessToken = token
}
export function clearAccessToken() {
  accessToken = null
}
export async function apiRequest(path, options = {}) {
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers,
      },
    })
  } catch {
    throw new Error(
      'Unable to reach Outpost. Check that the API is running and try again.',
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
  if (response.status === 204 || response.status === 202) return undefined
  if (options.responseType === 'blob') return await response.blob()
  return await response.json()
}
