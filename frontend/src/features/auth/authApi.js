import {
  apiRequest,
  authenticateSession,
  endAuthSession,
  restoreAuthSession,
  canStartGoogleSignIn,
  checkGoogleAvailability,
  beginGoogleSignIn,
  completeGoogleSignIn,
} from '../../shared/api/client'

export {
  canStartGoogleSignIn,
  checkGoogleAvailability,
  beginGoogleSignIn,
  completeGoogleSignIn,
}
export function dashboardPath(accountType) {
  return accountType === 'coordinator' ? '/app/coordinator' : '/app/student'
}
export function currentUser() {
  return apiRequest('/me')
}
export async function registerWithPassword(input) {
  await apiRequest('/auth/password/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
export function signInWithPassword(identifier, password) {
  return authenticateSession('/auth/password/login', { identifier, password })
}
export async function requestPhoneCode(phone) {
  await apiRequest('/auth/phone/request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  })
}
export function verifyPhoneCode(phone, code) {
  return authenticateSession('/auth/phone/verify', { phone, code })
}
export function restoreSession() {
  return restoreAuthSession()
}
export function signOut() {
  return endAuthSession()
}
export function signOutAll() {
  return endAuthSession('all')
}
export function getSessions() {
  return apiRequest('/auth/sessions')
}
export function revokeSession(id) {
  return apiRequest(`/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
export function requestPasswordReset(email) {
  return apiRequest('/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}
export function resetPassword(token, password) {
  return apiRequest('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}
export function requestEmailVerification(email) {
  return apiRequest('/auth/email-verification/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}
export function confirmEmailVerification(token) {
  return apiRequest('/auth/email-verification/confirm', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}
