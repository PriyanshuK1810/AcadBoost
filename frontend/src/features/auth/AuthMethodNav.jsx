import { Link } from 'react-router'
import { useEffect, useState } from 'react'
import { canStartGoogleSignIn, checkGoogleAvailability } from './authApi'

const methods = [
  { label: 'Password', to: '/login' },
  { label: 'Phone', to: '/auth/phone' },
  { label: 'Google', to: '/auth/google' },
]

export default function AuthMethodNav({ current, availability }) {
  const [serverAvailable, setServerAvailable] = useState(null)
  useEffect(() => {
    if (availability !== undefined || !canStartGoogleSignIn()) return
    let active = true
    checkGoogleAvailability()
      .then((value) => {
        if (active) setServerAvailable(value)
      })
      .catch(() => {
        if (active) setServerAvailable(false)
      })
    return () => {
      active = false
    }
  }, [availability])
  const unavailable =
    !canStartGoogleSignIn() ||
    availability === 'unavailable' ||
    serverAvailable === false

  return (
    <nav className="auth-method-nav" aria-label="Sign-in methods">
      {methods.map(({ label, to }) => (
        <Link
          key={to}
          to={to}
          aria-current={current === label ? 'page' : undefined}
        >
          {label}
          {label === 'Google' && unavailable && <small>Unavailable</small>}
        </Link>
      ))}
    </nav>
  )
}
