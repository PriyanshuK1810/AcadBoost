import { useEffect, useState } from 'react'
import { getSessions, requestEmailVerification, revokeSession } from './authApi'
import { useWorkspace } from '../workspace/hooks/useWorkspace'
import {
  PageHeading,
  SectionHeading,
} from '../workspace/components/WorkspaceUI'
export default function AccountPage() {
  const { user, signOut } = useWorkspace()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void getSessions()
      .then((items) => {
        if (active) setSessions(items)
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : 'Unable to load sessions.',
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])
  async function verifyEmail() {
    if (!user.primary_email) return
    setBusy('verify')
    setError('')
    setMessage('')
    try {
      await requestEmailVerification(user.primary_email)
      setMessage(
        'If verification is needed, a link has been sent to your email address.',
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to request verification.',
      )
    } finally {
      setBusy('')
    }
  }
  async function revoke(id) {
    setBusy(id)
    setError('')
    try {
      await revokeSession(id)
      setSessions((items) => items.filter((item) => item.id !== id))
      setMessage('Session revoked.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to revoke this session.',
      )
    } finally {
      setBusy('')
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Workspace / Account"
        title="Your account"
        description="Manage your profile, email verification, and active sign-in sessions."
      />
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="workspace-two-column">
        <section className="workspace-card">
          <SectionHeading title="Profile" description="Your account details" />
          <dl className="workspace-profile-list">
            <div>
              <dt>Name</dt>
              <dd>{user.display_name}</dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>{user.username || 'Not set'}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{user.primary_email || 'Not set'}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>{user.email_verified_at ? 'Verified' : 'Not verified'}</dd>
            </div>
          </dl>
          {user.primary_email && !user.email_verified_at && (
            <button
              className="workspace-button workspace-button-outline"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void verifyEmail()}
            >
              {busy === 'verify' ? 'Sending…' : 'Send verification email'}
            </button>
          )}
        </section>
        <section className="workspace-card">
          <SectionHeading
            title="Account access"
            description="Keep your workspace secure"
          />
          <p className="workspace-muted">
            Signing out of this device ends your current session. You can also
            revoke all active sessions below.
          </p>
          <button
            className="workspace-button workspace-button-outline"
            type="button"
            onClick={() => void signOut()}
          >
            Sign out of this device
          </button>
        </section>
      </div>
      <section className="workspace-section workspace-card">
        <SectionHeading
          title="Active sessions"
          description="Devices where your account is signed in"
        />
        {loading ? (
          <p>Loading sessions…</p>
        ) : sessions.length ? (
          <div className="workspace-session-list">
            {sessions.map((session) => (
              <div className="workspace-session" key={session.id}>
                <div>
                  <strong>
                    {session.is_current
                      ? 'This device'
                      : session.user_agent || 'Unknown device'}
                  </strong>
                  <p>
                    Started {new Date(session.created_at).toLocaleString()} ·
                    Last used {new Date(session.last_used_at).toLocaleString()}
                  </p>
                </div>
                {session.is_current ? (
                  <span className="workspace-data-pill">Current</span>
                ) : (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void revoke(session.id)}
                  >
                    {busy === session.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="workspace-muted">No active sessions found.</p>
        )}
        <div className="workspace-danger-zone">
          <div>
            <strong>Sign out everywhere</strong>
            <p>
              Revoke every active session for this account, including this
              device.
            </p>
          </div>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => signOut('all')}
          >
            Sign out all
          </button>
        </div>
      </section>
    </>
  )
}
