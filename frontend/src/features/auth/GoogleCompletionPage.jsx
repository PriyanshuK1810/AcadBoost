import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import AuthLayout from './AuthLayout'
import {
  completeGoogleSignIn,
  dashboardPath,
  restoreSession,
  signOut,
} from './authApi'

const resultMessages = {
  cancelled: 'Google sign-in was cancelled. You can try again.',
  invalid:
    'This Google sign-in attempt is invalid or expired. Please try again.',
  unavailable:
    'Google sign-in is unavailable right now. Please try again later.',
}

export default function GoogleCompletionPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const result = new URLSearchParams(location.search)
  const hasResult = result.has('result')
  const resultValue = result.get('result')
  const [error, setError] = useState('')
  const displayedError = hasResult
    ? Object.hasOwn(resultMessages, resultValue)
      ? resultMessages[resultValue]
      : resultMessages.invalid
    : error
  const [conflict, setConflict] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const activation = useRef(null)
  const errorRef = useRef(null)

  useEffect(() => {
    if (displayedError) errorRef.current?.focus()
  }, [displayedError])

  useEffect(() => {
    if (hasResult) return
    let active = true
    activation.current ??= completeGoogleSignIn()
    activation.current
      .then((user) => {
        if (active && user)
          navigate(dashboardPath(user.account_type), { replace: true })
        else if (active)
          setError('We couldn’t complete Google sign-in. Please try again.')
      })
      .catch((cause) => {
        if (!active) return
        if (cause?.code === 'session_conflict') {
          setConflict(true)
          setError(
            'You are already signed in. Continue with your current session or sign out first.',
          )
        } else if (cause?.code === 'google_activation_uncertain') {
          setError(
            'Your Google sign-in could not be confirmed. Check your current session before starting again.',
          )
        } else if (!cause?.status || cause.status >= 500) {
          setError(
            'Google sign-in is unavailable right now. Please try again later.',
          )
        } else {
          setError('We couldn’t complete Google sign-in. Please try again.')
        }
      })
    return () => {
      active = false
    }
  }, [hasResult, navigate])

  async function recover(action) {
    if (recovering) return
    setRecovering(true)
    try {
      if (action === 'resume') {
        const user = await restoreSession()
        if (!user) throw new Error('Session unavailable')
        navigate(dashboardPath(user.account_type), { replace: true })
      } else {
        await signOut()
        navigate('/login', { replace: true })
      }
    } catch {
      setError('We couldn’t confirm the current session. Please try again.')
    } finally {
      setRecovering(false)
    }
  }

  return (
    <AuthLayout
      eyebrow="Sign-in methods"
      title="Google sign-in"
      intro="Confirming your sign-in."
    >
      {displayedError ? (
        <>
          <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
            {displayedError}
          </p>
          {!hasResult && conflict && (
            <div>
              <button
                type="button"
                disabled={recovering}
                onClick={() => recover('resume')}
              >
                Continue current session
              </button>
              <button
                type="button"
                disabled={recovering}
                onClick={() => recover('signout')}
              >
                Sign out
              </button>
            </div>
          )}
          <p className="auth-switch">
            <Link to="/auth/google">Try again</Link>
          </p>
          <p className="auth-switch">
            <Link to="/login">Use password instead</Link>
          </p>
        </>
      ) : (
        <p className="auth-pending" role="status">
          Completing Google sign-in…
        </p>
      )}
    </AuthLayout>
  )
}
