import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import AuthLayout from './AuthLayout'
import {
  confirmEmailVerification,
  requestPasswordReset,
  resetPassword,
} from './authApi'

const labels = {
  forgot: [
    'Account recovery',
    'Reset your password',
    'Enter your account email to request a password reset link.',
  ],
  reset: [
    'Account recovery',
    'Create a new password',
    'Choose a password with at least 12 characters.',
  ],
  verify: [
    'Confirm your email',
    'Verify your address',
    'Confirm that you control the email address on your Acadboost account.',
  ],
}
const messages = {
  forgot:
    'Reset request accepted. If the address is eligible, check its inbox and spam folder for a link.',
  reset: 'Password updated. Sign in with your new password to continue.',
  verify: 'Email verified. You can return to My account or sign in.',
}

export default function AccountRecoveryPage({ mode }) {
  const [search, setSearch] = useSearchParams()
  const [token, setToken] = useState(() => search.get('token') ?? '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const errorRef = useRef(null)
  const resultRef = useRef(null)
  const [eyebrow, title, intro] = labels[mode]
  const needsLink = mode !== 'forgot'
  const missing = needsLink && (token.length < 43 || token.length > 512)
  const linkError =
    'This link is invalid, expired, or already used. Request a new link to continue.'

  useEffect(() => {
    if (!search.has('token')) return
    const clean = new URLSearchParams(search)
    clean.delete('token')
    setSearch(clean, { replace: true })
  }, [search, setSearch])

  useEffect(() => {
    if (error || outcome === 'invalid') errorRef.current?.focus()
    else if (outcome === 'complete') resultRef.current?.focus()
  }, [error, outcome])

  async function submit(event) {
    event.preventDefault()
    if (pending.current || outcome || missing) return
    setError('')
    if (
      mode === 'reset' &&
      (password.length < 12 || password.length > 1024 || password !== confirm)
    ) {
      setError(
        password !== confirm
          ? 'Your passwords do not match.'
          : 'Use 12 to 1,024 characters.',
      )
      return
    }
    pending.current = true
    setBusy(true)
    try {
      if (mode === 'forgot') await requestPasswordReset(email.trim())
      else if (mode === 'reset') await resetPassword(token, password)
      else await confirmEmailVerification(token)
      setOutcome('complete')
      setToken('')
      setPassword('')
      setConfirm('')
    } catch (cause) {
      if (needsLink && (cause?.status === 400 || cause?.status === 422)) {
        setOutcome('invalid')
        setToken('')
        setPassword('')
        setConfirm('')
      } else if (cause?.status === 429) {
        setError('Too many requests. Wait before trying again.')
      } else if (cause?.status === 403) {
        setError('This action is not permitted.')
      } else if (mode === 'reset') {
        setError(
          'We couldn’t confirm the password update. Try signing in with your new password before requesting another link.',
        )
      } else {
        setError('We couldn’t confirm the request. Wait before trying again.')
      }
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <AuthLayout eyebrow={eyebrow} title={title} intro={intro}>
      {outcome === 'complete' && (
        <p
          className={mode === 'forgot' ? 'auth-pending' : 'form-message'}
          role="status"
          tabIndex={-1}
          ref={resultRef}
        >
          {messages[mode]}
        </p>
      )}
      {(error || outcome === 'invalid' || (missing && !outcome)) && (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error ||
            (outcome === 'invalid'
              ? linkError
              : 'Open the full link from your email, or request a new one.')}
        </p>
      )}
      {!outcome && !missing && (
        <form className="auth-form" onSubmit={submit}>
          {mode === 'forgot' && (
            <label className="form-field">
              <span>Email address</span>
              <input
                type="email"
                autoComplete="email"
                maxLength={320}
                required
                readOnly={busy}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          )}
          {mode === 'reset' && (
            <>
              <label className="form-field">
                <span>New password</span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  readOnly={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="form-field">
                <span>Confirm new password</span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  readOnly={busy}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </label>
              <label className="auth-password-visibility">
                <input
                  type="checkbox"
                  checked={showPassword}
                  onChange={(event) => setShowPassword(event.target.checked)}
                />
                Show passwords
              </label>
            </>
          )}
          <button className="button button-primary auth-submit" disabled={busy}>
            {busy
              ? 'Please wait…'
              : mode === 'forgot'
                ? 'Request reset link'
                : mode === 'reset'
                  ? 'Update password'
                  : 'Verify email'}
          </button>
        </form>
      )}
      {mode === 'reset' && outcome !== 'complete' && (missing || error) && (
        <p className="auth-switch">
          <Link to="/auth/forgot-password">Request a new reset link</Link>
        </p>
      )}
      {mode === 'verify' && (missing || outcome) && (
        <p className="auth-switch">
          <Link to="/app/account">Go to My account</Link>
        </p>
      )}
      <p className="auth-switch">
        <a href="/login">Back to sign in</a>
      </p>
    </AuthLayout>
  )
}
