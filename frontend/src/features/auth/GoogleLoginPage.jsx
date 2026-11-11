import { Link } from 'react-router'
import AuthLayout from './AuthLayout'
import AuthMethodNav from './AuthMethodNav'

export default function GoogleLoginPage() {
  return (
    <AuthLayout
      eyebrow="Sign-in methods"
      title="Continue with Google"
      intro="Choose another method to access your Acadboost account."
    >
      <AuthMethodNav current="Google" />
      <div className="auth-method-note">
        <h2>Google sign-in is unavailable</h2>
        <p>You can still sign in with your password or request a phone code.</p>
      </div>
      <p className="auth-switch">
        <Link to="/login">Use password instead</Link>
      </p>
    </AuthLayout>
  )
}
