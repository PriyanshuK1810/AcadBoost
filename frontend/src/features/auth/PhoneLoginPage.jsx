import { useState } from 'react'
import { PRODUCT_BRAND } from '../../app/brand'
import AuthLayout from './AuthLayout'
import { dashboardPath, requestPhoneCode, verifyPhoneCode } from './authApi'
import { useNavigate } from 'react-router'
export default function PhoneLoginPage() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('request')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (step === 'request') {
        await requestPhoneCode(phone.trim())
        setStep('verify')
      } else {
        const user = await verifyPhoneCode(phone.trim(), code.trim())
        navigate(dashboardPath(user.account_type), { replace: true })
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to continue with phone sign in.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthLayout
      eyebrow="Another way to sign in"
      title="Use your phone number"
      intro={`Receive a one-time code to access your ${PRODUCT_BRAND} account.`}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field">
          <span>Phone number</span>
          <input
            type="tel"
            autoComplete="tel"
            placeholder="+91 98765 43210"
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            disabled={step === 'verify'}
          />
          <small>Include your country code.</small>
        </label>
        {step === 'verify' && (
          <label className="form-field">
            <span>Six-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        )}
        <button className="button button-primary auth-submit" disabled={busy}>
          {busy
            ? 'Please wait…'
            : step === 'request'
              ? 'Send code'
              : 'Verify and sign in'}
        </button>
        {step === 'verify' && (
          <button
            className="auth-secondary-button"
            type="button"
            onClick={() => {
              setStep('request')
              setCode('')
            }}
          >
            Use a different number
          </button>
        )}
      </form>
      <p className="auth-switch">
        Code delivery requires an SMS provider.{' '}
        <a href="/login">Use password instead</a>
      </p>
    </AuthLayout>
  )
}
