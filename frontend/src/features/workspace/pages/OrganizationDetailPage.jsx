import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  createOrganizationInvitation,
  getOrganization,
  listOrganizationInvitations,
  listOrganizationMembers,
  revokeOrganizationInvitation,
  transferOrganizationOwnership,
  updateOrganizationMember,
} from '../learningApi'
import { useWorkspace } from '../hooks/useWorkspace'
import { PageHeading } from '../components/WorkspaceUI'
import MentorAssignments from '../components/MentorAssignments'

export default function OrganizationDetailPage() {
  const { organizationId } = useParams()
  const { organizationScope } = useWorkspace()
  if (organizationScope?.loading)
    return <p role="status">Checking organization access…</p>
  if (organizationScope?.error)
    return (
      <div className="workspace-card">
        <p role="alert">{organizationScope.error}</p>
        <button className="workspace-button" onClick={organizationScope.retry}>
          Retry
        </button>
      </div>
    )
  const canManage = organizationScope?.organizations.some(
    ({ id, role }) => id === organizationId && role === 'owner',
  )
  if (!canManage)
    return (
      <PageHeading
        eyebrow="Workspace / Organizations"
        title="Owner access required"
        description="Only an active Owner of this organization can manage its members and staff invitations."
        action={
          <Link
            className="workspace-button workspace-button-outline"
            to="/app/organizations"
          >
            Back to organizations
          </Link>
        }
      />
    )
  return (
    <OrganizationDetails key={organizationId} organizationId={organizationId} />
  )
}

function OrganizationDetails({ organizationId }) {
  const { user, organizationScope } = useWorkspace()
  const navigate = useNavigate()
  const mounted = useRef(false)
  const pending = useRef(false)
  const [organization, setOrganization] = useState(null)
  const [members, setMembers] = useState([])
  const [membershipRevision, setMembershipRevision] = useState(0)
  const [invitations, setInvitations] = useState([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('coordinator')
  const [newCode, setNewCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([
      getOrganization(organizationId),
      listOrganizationMembers(organizationId),
      listOrganizationInvitations(organizationId),
    ])
      .then(([detail, rows, invites]) => {
        if (active) {
          setError('')
          setOrganization(detail)
          setMembers(rows)
          setInvitations(invites)
          setNewCode('')
        }
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Organization could not be loaded.',
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [organizationId])
  const visibleOrganization =
    organization?.id === organizationId ? organization : null

  async function run(action) {
    if (!visibleOrganization || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause?.status && cause.status < 500
            ? cause.message
            : 'The result could not be confirmed. Reload this organization before trying again.',
        )
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function refreshAfterChange(load, update) {
    try {
      const rows = await load(organizationId)
      if (mounted.current) update(rows)
    } catch {
      if (mounted.current) {
        setError(
          'The change was saved, but the list could not be refreshed. Reload this organization to see the latest data.',
        )
      }
    }
  }

  function changeMember(member, changes) {
    void run(async () => {
      await updateOrganizationMember(organizationId, member.id, changes)
      if (!mounted.current) return
      setNotice('Member updated.')
      setMembershipRevision((revision) => revision + 1)
      await refreshAfterChange(listOrganizationMembers, setMembers)
    })
  }

  function transfer(member) {
    if (
      !window.confirm(
        `Transfer ownership of ${organization.name} to ${member.display_name}?`,
      )
    )
      return
    void run(async () => {
      await transferOrganizationOwnership(organizationId, member.id)
      if (!mounted.current) return
      organizationScope?.retry()
      navigate('/app/organizations')
    })
  }

  function issueInvitation(event) {
    event.preventDefault()
    setNewCode('')
    void run(async () => {
      const issued = await createOrganizationInvitation(
        organizationId,
        email.trim(),
        role,
      )
      if (!mounted.current) return
      setNewCode(issued.code)
      setEmail('')
      setNotice(
        'Invitation created. Share the code with the recipient now; it will not be shown again.',
      )
      await refreshAfterChange(listOrganizationInvitations, setInvitations)
    })
  }

  function revoke(invitation) {
    setNewCode('')
    void run(async () => {
      await revokeOrganizationInvitation(organizationId, invitation.id)
      if (!mounted.current) return
      setNotice('Invitation revoked.')
      await refreshAfterChange(listOrganizationInvitations, setInvitations)
    })
  }

  return (
    <div className="organization-detail">
      <PageHeading
        eyebrow="Workspace / Organizations"
        title={visibleOrganization?.name ?? 'Organization'}
        description="Organization management · Owner access"
        action={
          <Link
            className="workspace-button workspace-button-outline"
            to={'/app/organizations?' + new URLSearchParams({ organizationId })}
          >
            Back to organizations
          </Link>
        }
      />
      {loading && <p role="status">Loading organization…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="workspace-notice" role="status">
          {notice}
        </p>
      )}
      {!loading && visibleOrganization && (
        <>
          <nav
            className="learning-actions"
            aria-label="Organization management"
          >
            <a
              className="workspace-text-link"
              href="#organization-members-title"
            >
              Members
            </a>
            <a className="workspace-text-link" href="#staff-invitations-title">
              Staff invitations
            </a>
            <a
              className="workspace-text-link"
              href="#mentor-assignments-heading"
            >
              Mentor assignments
            </a>
          </nav>
          <MentorAssignments
            key={membershipRevision}
            organizationId={organizationId}
          />
          <section
            className="workspace-card"
            aria-labelledby="organization-members-title"
          >
            <h2 id="organization-members-title" tabIndex={-1}>
              Members
            </h2>
            {members.length === 0 ? (
              <p>No members are listed for this organization.</p>
            ) : (
              <div className="organization-member-list">
                {members.map((member) => (
                  <article className="organization-member" key={member.id}>
                    <div className="organization-member-identity">
                      <h3>{member.display_name}</h3>
                      <p>
                        <span>{member.email ?? 'No email'}</span> ·{' '}
                        {member.account_type}
                      </p>
                      <small>
                        {member.role} · {member.status}
                      </small>
                    </div>
                    {member.role !== 'owner' && (
                      <div className="organization-member-actions">
                        {member.account_type === 'coordinator' && (
                          <label>
                            Role for {member.display_name}
                            <select
                              value={member.role}
                              disabled={busy}
                              onChange={(event) =>
                                changeMember(member, {
                                  role: event.target.value,
                                })
                              }
                            >
                              <option value="coordinator">Coordinator</option>
                              <option value="admin">Admin</option>
                              <option value="mentor">Mentor</option>
                            </select>
                          </label>
                        )}
                        <button
                          type="button"
                          className="workspace-button workspace-button-outline"
                          disabled={busy}
                          onClick={() =>
                            changeMember(member, {
                              status:
                                member.status === 'active'
                                  ? 'inactive'
                                  : 'active',
                            })
                          }
                        >
                          {member.status === 'active'
                            ? 'Deactivate'
                            : 'Reactivate'}
                        </button>
                        {member.account_type === 'coordinator' &&
                          member.status === 'active' &&
                          member.user_id !== user.id && (
                            <button
                              type="button"
                              className="workspace-button workspace-button-outline"
                              disabled={busy}
                              onClick={() => transfer(member)}
                            >
                              Transfer ownership
                            </button>
                          )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
          <section
            className="workspace-card"
            aria-labelledby="staff-invitations-title"
          >
            <h2 id="staff-invitations-title" tabIndex={-1}>
              Invite staff
            </h2>
            <p>
              Codes expire after seven days. The recipient must use this email
              on a verified coordinator account.
            </p>
            <form className="learning-inline-form" onSubmit={issueInvitation}>
              <label className="form-field">
                Staff email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="form-field">
                Invitation role
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                >
                  <option value="coordinator">Coordinator</option>
                  <option value="admin">Admin</option>
                  <option value="mentor">Mentor</option>
                </select>
              </label>
              <button className="workspace-button" disabled={busy}>
                Create invitation
              </button>
            </form>
            {newCode && (
              <div className="organization-invite-code" role="status">
                <strong>One-time invitation code</strong>
                <code>{newCode}</code>
                <span>
                  Copy and share this code securely. It is not stored in your
                  browser.
                </span>
              </div>
            )}
            <h3>Invitations</h3>
            {invitations.length === 0 ? (
              <p>No invitations yet.</p>
            ) : (
              <div className="organization-member-list">
                {invitations.map((invitation) => (
                  <article className="organization-member" key={invitation.id}>
                    <div className="organization-member-identity">
                      <strong>{invitation.email}</strong>
                      <p>
                        {invitation.role} · {invitation.status}
                      </p>
                      <small>
                        Expires{' '}
                        {new Date(invitation.expires_at).toLocaleDateString()}
                      </small>
                    </div>
                    {invitation.status === 'pending' && (
                      <button
                        type="button"
                        className="workspace-button workspace-button-outline"
                        disabled={busy}
                        onClick={() => revoke(invitation)}
                      >
                        Revoke
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
