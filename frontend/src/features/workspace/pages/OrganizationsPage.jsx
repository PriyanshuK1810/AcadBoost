import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useWorkspace } from '../hooks/useWorkspace'
import { withOrganization } from '../hooks/useOrganizationScope'
import { acceptOrganizationInvitation, listOrganizations } from '../learningApi'
import { EmptyState, PageHeading } from '../components/WorkspaceUI'

const membershipLabels = {
  owner: 'Owner',
  admin: 'Admin',
  coordinator: 'Coordinator',
  mentor: 'Mentor',
  student: 'Student',
}

export default function OrganizationsPage() {
  const { user, organizationScope } = useWorkspace()
  const usesWorkspaceMemberships = Boolean(organizationScope)
  const [organizations, setOrganizations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (usesWorkspaceMemberships) return
    let active = true
    void listOrganizations()
      .then((items) => {
        if (active) setOrganizations(items)
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Organizations could not be loaded.',
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [usesWorkspaceMemberships])
  const directory = organizationScope?.organizations ?? organizations
  const directoryLoading = organizationScope?.loading ?? loading
  const directoryError = error || organizationScope?.error
  const destination =
    user.account_type === 'coordinator'
      ? '/app/coordinator/learning'
      : '/app/student/learning'
  function acceptInvitation(event) {
    event.preventDefault()
    setInviteBusy(true)
    setError('')
    void acceptOrganizationInvitation(inviteCode.trim())
      .then(async (accepted) => {
        if (organizationScope) organizationScope.retry()
        else setOrganizations(await listOrganizations())
        setInviteCode('')
        setNotice(`Joined ${accepted.organization_name} as ${accepted.role}.`)
      })
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Invitation could not be accepted.',
        )
      })
      .finally(() => setInviteBusy(false))
  }
  return (
    <>
      <PageHeading
        eyebrow="Workspace / Organizations"
        title="Your organizations"
        description="Organizations appear here when you create one or join a coordinator's cohort."
        action={
          organizationScope?.organization?.role !== 'mentor' && (
            <Link
              className="workspace-button"
              to={withOrganization(
                destination,
                organizationScope?.organization?.id,
              )}
            >
              {user.account_type === 'coordinator'
                ? 'Create organization'
                : 'Join a cohort'}{' '}
              →
            </Link>
          )
        }
      />
      {directoryLoading && <p role="status">Loading organizations…</p>}
      {directoryError && (
        <p className="form-error" role="alert">
          {directoryError}
        </p>
      )}
      {notice && (
        <p className="workspace-notice" role="status">
          {notice}
        </p>
      )}
      {user.account_type === 'coordinator' && (
        <section className="workspace-card">
          <h2>Join an organization</h2>
          <p>
            Enter the staff invitation code sent by its owner. Your account
            email must be verified and match the invitation.
          </p>
          <form className="learning-inline-form" onSubmit={acceptInvitation}>
            <label className="form-field">
              Staff invitation code
              <input
                required
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
              />
            </label>
            <button className="workspace-button" disabled={inviteBusy}>
              Accept invitation
            </button>
          </form>
        </section>
      )}
      {!directoryLoading && !directoryError && directory.length === 0 && (
        <EmptyState
          title="No organization yet"
          description={
            user.account_type === 'coordinator'
              ? 'Create your first organization, then publish a roadmap.'
              : 'Join a cohort with the code from your coordinator.'
          }
          actionLabel={
            user.account_type === 'coordinator'
              ? 'Create organization'
              : 'Join cohort'
          }
          actionTo={destination}
        />
      )}
      <div className="learning-assignments">
        {directory.map((organization) => (
          <article
            className="workspace-card workspace-entity-card"
            key={organization.id}
          >
            <div className="workspace-entity-icon">O</div>
            <div className="workspace-entity-body">
              <p className="workspace-card-label">
                {membershipLabels[organization.role] ?? 'Staff'} membership
              </p>
              <h2>{organization.name}</h2>
              {organization.role === 'owner' && (
                <Link
                  className="workspace-text-link"
                  to={`/app/organizations/${organization.id}`}
                >
                  Manage organization →
                </Link>
              )}
              {organization.role === 'mentor' ? (
                <Link
                  className="workspace-text-link"
                  to={withOrganization(destination, organization.id)}
                >
                  Open Mentor workspace →
                </Link>
              ) : (
                <Link
                  className="workspace-text-link"
                  to={withOrganization(
                    destination,
                    organizationScope && organization.id,
                  )}
                >
                  Open learning workspace →
                </Link>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  )
}
