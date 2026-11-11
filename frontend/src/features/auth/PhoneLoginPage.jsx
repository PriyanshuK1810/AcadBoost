import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import AuthLayout from './AuthLayout'
import AuthMethodNav from './AuthMethodNav'
import { dashboardPath, requestPhoneCode, verifyPhoneCode } from './authApi'

function phoneError(status, verifying) {
  if (status === 429) return 'Too many requests. Wait before trying again.'
  if (status === 422 && !verifying)
    return 'Enter a valid phone number with its international country code.'
  if ((status === 400 || status === 401) && verifying)
    return 'The code is invalid or expired. Check the code or request another.'
  if (status === 403) return 'Phone sign-in is not permitted for this account.'
  if (status === 503)
    return 'Phone sign-in is unavailable right now. Use your password or try again later.'
  return verifying
    ? 'We couldn’t confirm sign-in. Try again or use your password.'
    : 'We couldn’t confirm the request. Check for a code before requesting another.'
}

export default function PhoneLoginPage() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [accepted, setAccepted] = useState(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const codeInput = useRef(null)
  const phoneInput = useRef(null)
  const errorRef = useRef(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (accepted) codeInput.current?.focus()
  }, [accepted])

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  async function run(verifying) {
    if (pending.current) return
    setError('')
    const number = phone.trim()
    if (!/^\+[1-9](?:[\d ().-]*\d)$/.test(number)) {
      setError('Include your international country code, starting with +.')
      return
    }
    if (verifying && !/^\d{6}$/.test(code)) {
      setError('Enter the six-digit verification code.')
      return
    }
    pending.current = true
    setBusy(verifying ? 'verify' : 'request')
    try {
      if (verifying) {
        const user = await verifyPhoneCode(number, code)
        if (!mounted.current) return
        setCode('')
        navigate(dashboardPath(user.account_type), { replace: true })
      } else {
        await requestPhoneCode(number)
        setCode('')
        setAccepted((count) => count + 1)
      }
    } catch (cause) {
      setError(phoneError(cause?.status, verifying))
    } finally {
      pending.current = false
      setBusy('')
    }
  }

  function changeNumber() {
    setAccepted(0)
    setCode('')
    setError('')
    phoneInput.current?.focus()
  }

  return (
    <AuthLayout
      eyebrow="Sign-in methods"
      title="Sign in with your phone"
      intro="Request a one-time code for an international phone number. Delivery depends on SMS availability."
    >
      <AuthMethodNav current="Phone" />
      {!!accepted && (
        <p className="auth-pending" role="status">
          Code request accepted. SMS delivery isn’t confirmed. If you receive a
          code, enter it below.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      <form
        className="auth-form"
        onSubmit={(event) => {
          event.preventDefault()
          void run(Boolean(accepted))
        }}
      >
        <label className="form-field">
          <span>Phone number</span>
          <input
            ref={phoneInput}
            type="tel"
            autoComplete="tel"
            required
            maxLength={40}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            readOnly={Boolean(accepted || busy)}
            aria-describedby="auth-phone-hint"
          />
          <small id="auth-phone-hint">Include your country code.</small>
        </label>
        {!!accepted && (
          <label className="form-field">
            <span>Six-digit code</span>
            <input
              ref={codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              readOnly={Boolean(busy)}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        )}
        <button
          className="button button-primary auth-submit"
          disabled={Boolean(busy)}
        >
          {busy === 'request'
            ? 'Requesting…'
            : busy === 'verify'
              ? 'Verifying…'
              : accepted
                ? 'Verify and sign in'
                : 'Request code'}
        </button>
        {!!accepted && (
          <div className="auth-inline-actions">
            <button
              className="auth-secondary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void run(false)}
            >
              Request another code
            </button>
            <button
              className="auth-secondary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={changeNumber}
            >
              Use a different number
            </button>
          </div>
        )}
      </form>
      <p className="auth-switch">
        <Link to="/login">Use password instead</Link>
      </p>
    </AuthLayout>
  )
}
