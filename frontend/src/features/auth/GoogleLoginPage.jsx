import AuthLayout from './AuthLayout'
import { PRODUCT_BRAND } from '../../app/brand'
export default function GoogleLoginPage() {
  return (
    <AuthLayout
      eyebrow="Google sign in"
      title="Continue with Google"
      intro={`This sign-in method needs an OAuth client configured for this ${PRODUCT_BRAND} installation.`}
    >
      <div className="auth-method-note">
        <h3>Setup in progress</h3>
        <p>
          The backend can validate Google sign-in, but the frontend callback and
          local OAuth configuration are not yet connected. Use password or phone
          sign in for the current review.
        </p>
      </div>
      <p className="auth-switch">
        <a href="/login">Back to password sign in</a>
      </p>
    </AuthLayout>
  )
}
