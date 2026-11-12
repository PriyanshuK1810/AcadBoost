import { Link } from 'react-router'
import { useEffect, useRef, useState } from 'react'
import AuthLayout from './AuthLayout'
import AuthMethodNav from './AuthMethodNav'
import {
  beginGoogleSignIn,
  canStartGoogleSignIn,
  checkGoogleAvailability,
} from './authApi'

export default function GoogleLoginPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const errorRef = useRef(null)
  const [availability, setAvailability] = useState(
    canStartGoogleSignIn() ? 'checking' : 'unavailable',
  )

  useEffect(() => {
    if (!canStartGoogleSignIn()) return
    let active = true
    checkGoogleAvailability()
      .then((available) => {
        if (active) setAvailability(available ? 'available' : 'unavailable')
      })
      .catch(() => {
        if (active) setAvailability('unavailable')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  async function start() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const destination = new URL(
        await beginGoogleSignIn(),
        window.location.origin,
      )
      if (
        destination.origin !== window.location.origin ||
        destination.pathname !== '/api/v1/auth/google/authorize' ||
        destination.hash
      ) {
        throw new Error('Invalid authorization destination')
      }
      window.location.assign(destination.href)
    } catch {
      setError(
        'We couldn’t start Google sign-in. Try again or use another method.',
      )
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Sign-in methods"
      title="Continue with Google"
      intro="Sign in to your Acadboost account."
    >
      <AuthMethodNav current="Google" availability={availability} />
      {availability === 'checking' ? (
        <p className="auth-pending" role="status">
          Checking Google sign-in�
        </p>
      ) : availability === 'available' ? (
        <>
          {error && (
            <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
              {error}
            </p>
          )}
          {busy && (
            <p className="auth-pending" role="status">
              Starting Google sign-in…
            </p>
          )}
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={start}
          >
            Continue with Google
          </button>
        </>
      ) : (
        <div className="auth-method-note">
          <h2>Google sign-in is unavailable</h2>
          <p>
            You can still sign in with your password or request a phone code.
          </p>
        </div>
      )}
      <p className="auth-switch">
        <Link to="/login">Use password instead</Link>
      </p>
    </AuthLayout>
  )
}
