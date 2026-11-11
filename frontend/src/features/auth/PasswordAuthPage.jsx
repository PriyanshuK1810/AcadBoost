import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import BrandWordmark from '../../app/BrandWordmark'
import { PRODUCT_BRAND } from '../../app/brand'
import {
  ApiRequestError,
  canRestoreSession,
  getSessionPhase,
} from '../../shared/api/client'
import {
  dashboardPath,
  registerWithPassword,
  restoreSession,
  signInWithPassword,
} from './authApi'
export default function PasswordAuthPage({ mode }) {
  const isRegistration = mode === 'register'
  const navigate = useNavigate()
  const location = useLocation()
  const registered = !isRegistration && Boolean(location.state?.registered)
  const signedOut = !isRegistration && Boolean(location.state?.signedOut)
  const unconfirmedSignOut =
    !isRegistration && getSessionPhase() === 'logout-failed'
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [accountType, setAccountType] = useState('student')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(!isRegistration && !registered)
  useEffect(() => {
    if (isRegistration || registered) return
    let active = true
    void restoreSession()
      .then((user) => {
        if (active && user && canRestoreSession())
          navigate(dashboardPath(user.account_type), { replace: true })
      })
      .finally(() => {
        if (active) setRestoring(false)
      })
    return () => {
      active = false
    }
  }, [isRegistration, registered, navigate])
  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (isRegistration && password !== confirmPassword) {
      setError('Your passwords do not match.')
      return
    }
    setBusy(true)
    try {
      if (isRegistration) {
        await registerWithPassword({
          display_name: displayName.trim(),
          username: username.trim(),
          email: email.trim(),
          password,
          account_type: accountType,
        })
        setPassword('')
        setConfirmPassword('')
        navigate('/login', { replace: true, state: { registered: true } })
      } else {
        const user = await signInWithPassword(identifier.trim(), password)
        setPassword('')
        navigate(dashboardPath(user.account_type), { replace: true })
      }
    } catch (requestError) {
      setError(
        isRegistration &&
          requestError instanceof ApiRequestError &&
          requestError.status === 409
          ? 'This email or username is already registered. Sign in instead.'
          : requestError instanceof Error
            ? requestError.message
            : 'Something went wrong. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-page">
      <header className="auth-header page-container">
        <BrandWordmark className="wordmark" href="/" />
        <a className="auth-home-link" href="/">
          Back to homepage <span aria-hidden="true">↗</span>
        </a>
      </header>
      <div className="auth-layout page-container">
        <aside className="auth-story">
          <p className="eyebrow eyebrow-light">
            Learning today, brighter tomorrows
          </p>
          <h1>A clearer path starts here.</h1>
          <p>
            {PRODUCT_BRAND} brings learning, practice, and progress together so
            every student can move forward with confidence.
          </p>
          <div className="auth-story-footer">
            <span className="auth-story-marker" aria-hidden="true">
              01
            </span>
            <span>Learn with purpose. Grow with confidence.</span>
          </div>
        </aside>
        <section className="auth-card" aria-labelledby="auth-title">
          <p className="eyebrow">
            {isRegistration ? `Join ${PRODUCT_BRAND}` : 'Welcome back'}
          </p>
          <h2 id="auth-title">
            {isRegistration ? 'Create your account' : 'Sign in'}
          </h2>
          <p className="auth-intro">
            {isRegistration
              ? `Choose your account type and start your ${PRODUCT_BRAND} journey.`
              : 'Pick up where your learning journey left off.'}
          </p>
          {registered && (
            <p className="form-message" role="status">
              Account created. Sign in with your new credentials to continue.
            </p>
          )}
          {signedOut && (
            <p className="form-message" role="status">
              You’ve signed out.
            </p>
          )}
          {unconfirmedSignOut && (
            <p className="form-error" role="alert">
              We couldn’t confirm your previous sign-out. You can sign in here
              or return to the workspace to retry sign-out.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <form className="auth-form" onSubmit={handleSubmit}>
            {isRegistration ? (
              <>
                <fieldset className="account-type-fieldset">
                  <legend>Account type</legend>
                  <label className="account-type-option">
                    <input
                      type="radio"
                      name="account_type"
                      value="student"
                      checked={accountType === 'student'}
                      onChange={() => setAccountType('student')}
                    />
                    <span>
                      <strong>Student</strong>
                      <small>Follow your roadmap and track progress.</small>
                    </span>
                  </label>
                  <label className="account-type-option">
                    <input
                      type="radio"
                      name="account_type"
                      value="coordinator"
                      checked={accountType === 'coordinator'}
                      onChange={() => setAccountType('coordinator')}
                    />
                    <span>
                      <strong>Coordinator</strong>
                      <small>Review cohort progress and learning plans.</small>
                    </span>
                  </label>
                </fieldset>
                <label className="form-field">
                  <span>Full name</span>
                  <input
                    autoComplete="name"
                    maxLength={200}
                    required
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>Username</span>
                  <input
                    autoComplete="username"
                    minLength={3}
                    maxLength={64}
                    pattern="[A-Za-z0-9_]+"
                    required
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                  <small>3–64 letters, numbers, or underscores.</small>
                </label>
                <label className="form-field">
                  <span>Email address</span>
                  <input
                    autoComplete="email"
                    maxLength={320}
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="form-field">
                <span>Email or username</span>
                <input
                  autoComplete="username"
                  required
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                />
              </label>
            )}
            <label className="form-field">
              <span>Password</span>
              <input
                autoComplete={
                  isRegistration ? 'new-password' : 'current-password'
                }
                minLength={isRegistration ? 12 : 1}
                maxLength={1024}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {isRegistration && <small>Use at least 12 characters.</small>}
            </label>
            {isRegistration && (
              <label className="form-field">
                <span>Confirm password</span>
                <input
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
            )}
            <button
              className="button button-primary auth-submit"
              type="submit"
              disabled={busy || restoring}
            >
              {restoring
                ? 'Checking your session…'
                : busy
                  ? isRegistration
                    ? 'Creating account…'
                    : 'Signing in…'
                  : isRegistration
                    ? 'Create account'
                    : 'Sign in'}
              {!busy && !restoring && <span aria-hidden="true">→</span>}
            </button>
          </form>
          {!isRegistration && (
            <div className="auth-method-links">
              <a href="/auth/forgot-password">Forgot password?</a>
              <a href="/auth/phone">Use phone code</a>
              <a href="/auth/google">Google sign in</a>
            </div>
          )}
          <p className="auth-switch">
            {isRegistration
              ? 'Already have an account?'
              : `New to ${PRODUCT_BRAND}?`}{' '}
            <a href={isRegistration ? '/login' : '/register'}>
              {isRegistration ? 'Sign in' : 'Create an account'}
            </a>
          </p>
          <p className="auth-footnote">
            Your account is protected by {PRODUCT_BRAND} authentication.
          </p>
        </section>
      </div>
    </main>
  )
}
