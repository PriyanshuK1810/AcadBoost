import { Link } from 'react-router'

const methods = [
  { label: 'Password', to: '/login' },
  { label: 'Phone', to: '/auth/phone' },
  { label: 'Google', to: '/auth/google' },
]

export default function AuthMethodNav({ current }) {
  return (
    <nav className="auth-method-nav" aria-label="Sign-in methods">
      {methods.map(({ label, to }) => (
        <Link
          key={to}
          to={to}
          aria-current={current === label ? 'page' : undefined}
        >
          {label}
          {label === 'Google' && <small>Unavailable</small>}
        </Link>
      ))}
    </nav>
  )
}
