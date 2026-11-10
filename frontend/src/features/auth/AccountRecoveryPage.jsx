import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { PRODUCT_BRAND } from '../../app/brand'
import AuthLayout from './AuthLayout'
import {
  confirmEmailVerification,
  requestPasswordReset,
  resetPassword,
} from './authApi'
export default function AccountRecoveryPage({ mode }) {
  const [search] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [token, setToken] = useState(search.get('token') ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const labels = {
    forgot: [
      'Account recovery',
      'Reset your password',
      'Enter your account email. If it exists, we’ll send a reset link.',
    ],
    reset: [
      'Choose a password',
      'Set a new password',
      'Use the link from your recovery email to secure your account.',
    ],
    verify: [
      'Confirm your email',
      'Verify your address',
      `Use the link from your ${PRODUCT_BRAND} verification email.`,
    ],
  }[mode]
  async function submit(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    if (mode === 'reset' && password !== confirm) {
      setError('Your passwords do not match.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email.trim())
        setMessage('If that account exists, a reset link has been sent.')
      } else if (mode === 'reset') {
        await resetPassword(token.trim(), password)
        setMessage('Password updated. You can sign in now.')
      } else {
        await confirmEmailVerification(token.trim())
        setMessage('Email verified. You can return to your account.')
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to complete this request.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthLayout eyebrow={labels[0]} title={labels[1]} intro={labels[2]}>
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form className="auth-form" onSubmit={submit}>
        {mode === 'forgot' ? (
          <label className="form-field">
            <span>Email address</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        ) : (
          <label className="form-field">
            <span>Verification token</span>
            <input
              required
              minLength={43}
              maxLength={512}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <small>Filled automatically when you open your email link.</small>
          </label>
        )}
        {mode === 'reset' && (
          <>
            <label className="form-field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="form-field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          </>
        )}
        <button
          className="button button-primary auth-submit"
          type="submit"
          disabled={busy}
        >
          {busy
            ? 'Please wait…'
            : mode === 'forgot'
              ? 'Send reset link'
              : mode === 'reset'
                ? 'Update password'
                : 'Verify email'}
        </button>
      </form>
      <p className="auth-switch">
        <a href="/login">Back to sign in</a>
      </p>
    </AuthLayout>
  )
}
