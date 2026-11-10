import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import LiveResourceState from '../components/LiveResourceState'
import { useLiveResource } from '../hooks/useLiveResource'
import {
  learningRoles,
  useOrganizationScope,
  withOrganization,
} from '../hooks/useOrganizationScope'
import {
  EmptyState,
  PageHeading,
  SectionHeading,
} from '../components/WorkspaceUI'
import {
  createCohort,
  createOrganization,
  getCohortEnrollments,
  listCohorts,
  listRoadmaps,
  reactivateCohortEnrollment,
  removeCohortEnrollment,
  revokeCohortJoinCode,
  rotateCohortJoinCode,
} from '../learningApi'
export default function CoordinatorLearningPage() {
  const [search] = useSearchParams()
  const scope = useOrganizationScope()
  const preferredVersion = search.get('roadmapVersionId')
  return (
    <LearningSetup
      key={JSON.stringify([
        scope.organization?.id,
        scope.requestedId,
        preferredVersion,
      ])}
      scope={scope}
      preferredVersion={preferredVersion}
    />
  )
}

function LearningSetup({ scope, preferredVersion }) {
  const { organization, organizations } = scope
  const organizationId = organization?.id
  const allowed = organization && learningRoles.includes(organization.role)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const load = useCallback(async () => {
    if (!allowed) return null
    const [roadmaps, cohorts] = await Promise.all([
      listRoadmaps(organizationId),
      listCohorts(organizationId),
    ])
    return {
      roadmaps: roadmaps.filter(
        (row) => !row.organization_id || row.organization_id === organizationId,
      ),
      cohorts: cohorts.filter(
        (row) => !row.organization_id || row.organization_id === organizationId,
      ),
    }
  }, [allowed, organizationId])
  const resource = useLiveResource(load)
  const [cohortUpdates, setCohorts] = useState(null)
  const cohorts = cohortUpdates ?? resource.data?.cohorts ?? []
  function updateCohorts(update) {
    setCohorts((current) => update(current ?? resource.data?.cohorts ?? []))
  }
  const [oneTimeCodes, setOneTimeCodes] = useState({})
  const [rosters, setRosters] = useState({})
  const [rosterOpen, setRosterOpen] = useState({})
  const [rosterLoading, setRosterLoading] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [cohortName, setCohortName] = useState('')
  const [chosenVersion, setVersionId] = useState(preferredVersion ?? '')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const publishedRoadmaps = (resource.data?.roadmaps ?? []).filter(
    (roadmap) => roadmap.status === 'published',
  )
  const versionId =
    publishedRoadmaps.find((row) => row.version_id === chosenVersion)
      ?.version_id ??
    publishedRoadmaps[0]?.version_id ??
    ''
  useEffect(() => {
    if (preferredVersion && versionId === preferredVersion) {
      document
        .getElementById('cohort-setup')
        ?.scrollIntoView?.({ block: 'start' })
    }
  }, [preferredVersion, versionId])

  async function addOrganization(event) {
    event.preventDefault()
    if (busy) return
    setBusy('organization')
    setError('')
    setMessage('')
    try {
      const created = await createOrganization(organizationName.trim())
      if (!mounted.current) return
      scope.rememberOrganization(created)
      setOrganizationName('')
      setMessage('Organization created. Add its first roadmap next.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Organization could not be created.',
      )
    } finally {
      setBusy('')
    }
  }
  async function addCohort(event) {
    event.preventDefault()
    if (busy || !allowed || !versionId || resource.loading || resource.error)
      return
    setBusy('cohort')
    setError('')
    setMessage('')
    try {
      const created = await createCohort(
        organizationId,
        cohortName.trim(),
        versionId,
      )
      if (!mounted.current) return
      if (
        created.organization_id &&
        created.organization_id !== organizationId
      ) {
        throw new Error(
          'The cohort could not be confirmed for this organization. Reload before trying again.',
        )
      }
      const { invite_code: inviteCode, ...cohortMetadata } = created
      updateCohorts((items) => [...items, cohortMetadata])
      if (inviteCode) {
        setOneTimeCodes((codes) => ({
          ...codes,
          [created.id]: inviteCode,
        }))
      }
      setCohortName('')
      setMessage('Cohort created. Share its join code with a student.')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Cohort could not be created.',
      )
    } finally {
      setBusy('')
    }
  }
  async function rotateCode(cohort) {
    if (!allowed || !cohorts.some((row) => row.id === cohort.id)) return
    setBusy(`rotate:${cohort.id}`)
    setError('')
    setMessage('')
    try {
      const rotated = await rotateCohortJoinCode(cohort.id)
      if (!mounted.current) return
      if (
        rotated.id !== cohort.id ||
        (rotated.organization_id && rotated.organization_id !== organizationId)
      ) {
        throw new Error(
          'The join code could not be confirmed for this cohort. Reload before trying again.',
        )
      }
      const { invite_code: inviteCode, ...cohortMetadata } = rotated
      updateCohorts((items) =>
        items.map((item) =>
          item.id === cohort.id ? { ...item, ...cohortMetadata } : item,
        ),
      )
      setOneTimeCodes((codes) => ({
        ...codes,
        [cohort.id]: inviteCode,
      }))
      setMessage(
        `A new join code for ${cohort.name} is shown once. The previous code no longer works.`,
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The join code could not be rotated.',
      )
    } finally {
      setBusy('')
    }
  }
  async function revokeCode(cohort) {
    if (!allowed || !cohorts.some((row) => row.id === cohort.id)) return
    setBusy(`revoke:${cohort.id}`)
    setError('')
    setMessage('')
    try {
      await revokeCohortJoinCode(cohort.id)
      if (!mounted.current) return
      updateCohorts((items) =>
        items.map((item) =>
          item.id === cohort.id
            ? {
                ...item,
                join_code_status: 'revoked',
                invite_code_expires_at: null,
              }
            : item,
        ),
      )
      setOneTimeCodes((codes) => {
        const next = { ...codes }
        delete next[cohort.id]
        return next
      })
      setMessage(`The join code for ${cohort.name} has been revoked.`)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The join code could not be revoked.',
      )
    } finally {
      setBusy('')
    }
  }
  async function toggleRoster(cohort) {
    if (!allowed || !cohorts.some((row) => row.id === cohort.id)) return
    if (rosterOpen[cohort.id]) {
      setRosterOpen((open) => ({ ...open, [cohort.id]: false }))
      return
    }
    if (!Object.hasOwn(rosters, cohort.id)) {
      setRosterLoading(cohort.id)
      setError('')
      try {
        const enrollments = await getCohortEnrollments(cohort.id)
        if (!mounted.current) return
        setRosters((current) => ({ ...current, [cohort.id]: enrollments }))
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'The cohort roster could not be loaded.',
        )
        setRosterLoading('')
        return
      } finally {
        setRosterLoading('')
      }
    }
    setRosterOpen((open) => ({ ...open, [cohort.id]: true }))
  }
  async function changeEnrollment(cohort, enrollment, reactivate) {
    if (busy || !allowed || !cohorts.some((row) => row.id === cohort.id)) return
    setBusy(`${reactivate ? 'reinstate' : 'remove'}:${enrollment.id}`)
    setError('')
    setMessage('')
    try {
      if (reactivate) await reactivateCohortEnrollment(cohort.id, enrollment.id)
      else await removeCohortEnrollment(cohort.id, enrollment.id)
      if (!mounted.current) return
      const updated = await getCohortEnrollments(cohort.id)
      if (!mounted.current) return
      setRosters((current) => ({ ...current, [cohort.id]: updated }))
      updateCohorts((current) =>
        current.map((item) =>
          item.id === cohort.id
            ? {
                ...item,
                student_count: updated.filter((row) => row.status === 'active')
                  .length,
              }
            : item,
        ),
      )
      setMessage(
        reactivate
          ? `${enrollment.display_name} was reinstated.`
          : `${enrollment.display_name} was removed from the cohort.`,
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Enrollment could not be updated.',
      )
    } finally {
      setBusy('')
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Coordinator / Live learning"
        title="Build a learning journey"
        description="Set up an organization, manage its learning roadmaps, and assign a published version to a cohort."
      />
      <LiveResourceState {...scope} />
      {!scope.loading &&
        !scope.error &&
        scope.requestedId !== null &&
        !allowed && (
          <p className="form-error" role="alert">
            {organization
              ? `Your role cannot manage live learning for ${organization.name}.`
              : 'This organization is unavailable.'}
          </p>
        )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      <div className="learning-steps">
        <section className="workspace-card learning-step">
          <SectionHeading
            title="1. Organization"
            description="Your college or training group"
          />
          <form className="learning-form" onSubmit={addOrganization}>
            <label className="form-field">
              <span>Organization name</span>
              <input
                required
                minLength={2}
                maxLength={200}
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                placeholder="Example College"
              />
            </label>
            <button className="workspace-button" disabled={busy !== ''}>
              {' '}
              {busy === 'organization'
                ? 'Creating…'
                : 'Create organization'}{' '}
            </button>
          </form>
          {!scope.managed && organizations.length > 0 && (
            <label className="form-field">
              <span>Working in</span>
              <select
                value={organizationId ?? ''}
                onChange={(event) =>
                  scope.selectOrganization(event.target.value)
                }
              >
                <option value="" disabled>
                  Select an organization
                </option>
                {organizations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {scope.managed && organization && (
            <p>Working in {organization.name}</p>
          )}
        </section>

        <section className="workspace-card learning-step">
          <SectionHeading
            title="2. Roadmap"
            description="Manage roadmap drafts, submissions, and published versions"
          />
          {allowed ? (
            <Link
              className="workspace-button"
              to={
                '/app/coordinator/roadmaps?' +
                new URLSearchParams({ organizationId })
              }
            >
              Browse organization roadmaps
            </Link>
          ) : (
            <p>Create or select an organization to manage roadmaps.</p>
          )}
        </section>

        <section className="workspace-card learning-step" id="cohort-setup">
          <SectionHeading
            title="3. Cohort"
            description="Assign an exact roadmap version and share its join code"
          />
          {allowed && (
            <LiveResourceState
              {...resource}
              loading={false}
              error={
                resource.error
                  ? `Could not load learning data for ${organization.name}. ${resource.error}`
                  : ''
              }
            />
          )}
          {allowed && resource.loading && (
            <p role="status">Loading learning data for {organization.name}…</p>
          )}
          {allowed &&
            resource.data &&
            (publishedRoadmaps.length ? (
              <form className="learning-form" onSubmit={addCohort}>
                <label className="form-field">
                  <span>Cohort name</span>
                  <input
                    required
                    minLength={2}
                    maxLength={200}
                    value={cohortName}
                    onChange={(event) => setCohortName(event.target.value)}
                    placeholder="2026 placement group"
                  />
                </label>
                <label className="form-field">
                  <span>Roadmap</span>
                  <select
                    required
                    value={versionId}
                    onChange={(event) => setVersionId(event.target.value)}
                  >
                    {publishedRoadmaps.map((roadmap) => (
                      <option
                        key={roadmap.version_id}
                        value={roadmap.version_id}
                      >
                        {roadmap.name} · v{roadmap.version_number}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="workspace-button" disabled={busy !== ''}>
                  {busy === 'cohort' ? 'Creating…' : 'Create cohort'}
                </button>
              </form>
            ) : (
              <p>Publish a roadmap before creating a cohort.</p>
            ))}
          {allowed &&
            resource.data &&
            (cohorts.length ? (
              <div className="learning-list">
                {cohorts.map((cohort) => (
                  <div className="learning-list-item" key={cohort.id}>
                    <div>
                      <strong>{cohort.name}</strong>
                      <span>
                        {cohort.roadmap_name} · {cohort.student_count} students
                      </span>
                    </div>
                    <div className="learning-invite">
                      <span>
                        Student join code ·{' '}
                        {cohort.join_code_status || 'unknown'}
                      </span>
                      {cohort.invite_code_expires_at && (
                        <small>
                          Expires{' '}
                          {new Date(
                            cohort.invite_code_expires_at,
                          ).toLocaleDateString()}
                        </small>
                      )}
                      {oneTimeCodes[cohort.id] ? (
                        <>
                          <code>{oneTimeCodes[cohort.id]}</code>
                          <small>
                            Copy this code now. It will not be shown again.
                          </small>
                        </>
                      ) : (
                        <small>
                          {cohort.join_code_status === 'active'
                            ? 'The code was shown when it was created or rotated.'
                            : 'No usable join code is available.'}
                        </small>
                      )}
                      <div className="learning-actions">
                        <button
                          type="button"
                          className="workspace-button workspace-button-outline"
                          disabled={busy !== ''}
                          onClick={() => void rotateCode(cohort)}
                        >
                          {busy === `rotate:${cohort.id}`
                            ? 'Rotating…'
                            : 'Rotate join code'}
                        </button>
                        <button
                          type="button"
                          className="workspace-button workspace-button-outline"
                          disabled={
                            busy !== '' || cohort.join_code_status === 'revoked'
                          }
                          onClick={() => void revokeCode(cohort)}
                        >
                          {busy === `revoke:${cohort.id}`
                            ? 'Revoking…'
                            : 'Revoke join code'}
                        </button>
                      </div>
                    </div>
                    <div className="learning-roster-controls">
                      <button
                        type="button"
                        className="workspace-button workspace-button-outline"
                        disabled={rosterLoading === cohort.id || busy !== ''}
                        onClick={() => void toggleRoster(cohort)}
                      >
                        {rosterLoading === cohort.id
                          ? 'Loading roster…'
                          : rosterOpen[cohort.id]
                            ? 'Hide roster'
                            : 'Show roster'}
                      </button>
                      {rosterOpen[cohort.id] && (
                        <div
                          className="learning-roster"
                          aria-label={`${cohort.name} roster`}
                        >
                          {rosters[cohort.id]?.length ? (
                            rosters[cohort.id].map((enrollment) => (
                              <div
                                className="learning-roster-item"
                                key={enrollment.id}
                              >
                                <div>
                                  <strong>{enrollment.display_name}</strong>
                                  <span>
                                    {enrollment.status === 'active'
                                      ? 'Active'
                                      : `Inactive · ${enrollment.end_reason || 'ended'}`}
                                  </span>
                                </div>
                                {enrollment.status === 'active' ? (
                                  <button
                                    type="button"
                                    className="workspace-button workspace-button-outline"
                                    disabled={busy !== ''}
                                    onClick={() =>
                                      void changeEnrollment(
                                        cohort,
                                        enrollment,
                                        false,
                                      )
                                    }
                                    aria-label={`Remove ${enrollment.display_name}`}
                                  >
                                    Remove
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="workspace-button workspace-button-outline"
                                    disabled={busy !== ''}
                                    onClick={() =>
                                      void changeEnrollment(
                                        cohort,
                                        enrollment,
                                        true,
                                      )
                                    }
                                    aria-label={`Reinstate ${enrollment.display_name}`}
                                  >
                                    Reinstate
                                  </button>
                                )}
                              </div>
                            ))
                          ) : (
                            <p>No student enrollments yet.</p>
                          )}
                        </div>
                      )}
                    </div>
                    <Link
                      className="workspace-text-link"
                      to={withOrganization(
                        `/app/coordinator/learning/${cohort.id}`,
                        organizationId,
                      )}
                    >
                      View live progress →
                    </Link>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No cohorts yet"
                description="Create a cohort to invite a student and see their progress here."
              />
            ))}
        </section>
      </div>
    </>
  )
}
