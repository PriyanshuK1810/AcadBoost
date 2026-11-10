import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import ForestLandscapeArtwork from '../components/ForestLandscapeArtwork'
import RoadmapLifecycleSections from '../components/RoadmapLifecycleSections'
import { EmptyState, PageHeading } from '../components/WorkspaceUI'
import { createRoadmap, listRoadmaps } from '../learningApi'
import {
  learningRoles,
  useOrganizationScope,
} from '../hooks/useOrganizationScope'
import { UploadedPlans } from './ActivityPlanUploadPage'

const statuses = [
  ['draft', 'Draft'],
  ['in_review', 'In review'],
  ['published', 'Published'],
  ['archived', 'Archived'],
]

function groupRoadmaps(versions) {
  const roadmaps = new Map()
  for (const version of versions) {
    if (!roadmaps.has(version.id)) roadmaps.set(version.id, [])
    roadmaps.get(version.id).push(version)
  }
  return Array.from(roadmaps.values(), (rows) => {
    const numbered = rows.filter((row) => Number.isInteger(row.version_number))
    numbered.sort((a, b) => b.version_number - a.version_number)
    return {
      details: numbered[0] || rows[0],
      latest: numbered[0],
      rows,
    }
  })
}

function OrganizationPicker({ organizations, organizationId, onChange }) {
  return (
    <label className="form-field">
      Organization for roadmaps
      <select
        value={organizationId}
        onChange={(event) => onChange(event.target.value)}
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
  )
}

export default function RoadmapsPage() {
  const scope = useOrganizationScope()
  const {
    organization,
    organizations,
    requestedId,
    loading,
    error,
    errorStatus,
  } = scope
  const denied = [401, 403].includes(errorStatus)
  const picker =
    !scope.managed && organizations.length > 0 ? (
      <OrganizationPicker
        organizations={organizations}
        organizationId={organization?.id || ''}
        onChange={scope.selectOrganization}
      />
    ) : null
  const heading = (
    <div className="roadmap-page-header roadmap-discovery-heading">
      <ForestLandscapeArtwork />
      <PageHeading
        eyebrow="Coordinator / Learning / Roadmaps"
        title="Roadmaps"
        description="Plan, build, and manage learning roadmaps for your organization."
      />
    </div>
  )
  return (
    <div className="roadmap-discovery">
      {heading}
      <Link
        className="workspace-text-link"
        to={
          organization
            ? '/app/coordinator/learning?' +
              new URLSearchParams({ organizationId: organization.id })
            : '/app/coordinator/learning'
        }
      >
        ← Learning
      </Link>
      {loading && <p role="status">Loading organizations…</p>}
      {error && (
        <div>
          <p className="form-error" role="alert">
            {denied
              ? 'You do not have access to organizations.'
              : 'Organizations could not be loaded.'}
          </p>
          {!denied && (
            <button
              type="button"
              className="workspace-button workspace-button-outline"
              onClick={scope.retry}
            >
              Retry organizations
            </button>
          )}
        </div>
      )}
      {!loading && !error && !organization && (
        <>
          {picker}
          {requestedId !== null ? (
            <p className="form-error" role="alert">
              This organization is unavailable. Select an organization you can
              access.
            </p>
          ) : (
            <EmptyState
              title="Select an organization"
              description="Join or create an organization in Learning to manage roadmaps."
            />
          )}
        </>
      )}
      {organization &&
        (learningRoles.includes(organization.role) ? (
          <OrganizationRoadmaps
            key={organization.id}
            organizationId={organization.id}
            role={organization.role}
            picker={picker}
          />
        ) : (
          <>
            {picker}
            <p className="form-error" role="alert">
              Your role does not have access to this organization’s roadmap
              management.
            </p>
          </>
        ))}
    </div>
  )
}

function OrganizationRoadmaps({ organizationId, role, picker }) {
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState('')
  const [versions, setVersions] = useState(null)
  const [createdDrafts, setCreatedDrafts] = useState(() => new Map())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [topics, setTopics] = useState('')
  const [busy, setBusy] = useState(false)
  const creationPending = useRef(false)
  const [retry, setRetry] = useState(0)
  const [listError, setListError] = useState('')
  const [formError, setFormError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    queueMicrotask(async () => {
      if (!active) return
      try {
        const rows = await listRoadmaps(organizationId)
        if (active) {
          const scoped = rows.filter(
            (row) => row.organization_id === organizationId,
          )
          setVersions([
            ...new Map(
              scoped.map((row) => [row.version_id || row, row]),
            ).values(),
          ])
        }
      } catch (cause) {
        if (active)
          setListError(
            [401, 403].includes(cause?.status) ? 'denied' : 'unavailable',
          )
      }
    })
    return () => {
      active = false
    }
  }, [organizationId, retry])

  async function createDraft(event) {
    event.preventDefault()
    if (creationPending.current || !versions || listError) return
    const titles = topics
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (titles.length < 1 || titles.length > 24) {
      setFormError('Enter 1–24 starter topics, one per line.')
      return
    }
    creationPending.current = true
    setBusy(true)
    setFormError('')
    setMessage('')
    try {
      const created = await createRoadmap(organizationId, {
        name: name.trim(),
        description: description.trim(),
        topics: titles.map((title) => ({ title, description: '' })),
      })
      if (created.organization_id !== organizationId) {
        setFormError(
          'The created roadmap could not be confirmed for this organization. Reload the list before trying again.',
        )
        return
      }
      setCreatedDrafts((current) =>
        new Map(current).set(created.version_id, created),
      )
      setName('')
      setDescription('')
      setTopics('')
      setFilter('')
      setStatus('')
      setMessage('Draft created. Open its versions to continue.')
    } catch (cause) {
      setFormError(
        [401, 403].includes(cause?.status)
          ? 'You do not have permission to create a roadmap in this organization.'
          : 'The roadmap could not be created. Check your entries and try again.',
      )
    } finally {
      creationPending.current = false
      setBusy(false)
    }
  }

  const roadmaps = groupRoadmaps([
    ...(versions || []),
    ...createdDrafts.values(),
  ])
  const query = filter.trim().toLowerCase()
  const visibleRoadmaps = roadmaps.filter(({ details }) =>
    [details.name, details.description].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  )
  const organizationQuery = new URLSearchParams({ organizationId }).toString()

  return (
    <>
      <div className="roadmap-discovery-toolbar">
        {picker}
        {versions && (
          <div className="roadmap-discovery-actions">
            <Link
              className="workspace-button workspace-button-outline"
              to={'/app/coordinator/activity-plans/new?' + organizationQuery}
            >
              Import from PDF
            </Link>
            <button
              type="button"
              className="workspace-button"
              aria-expanded={creating}
              aria-controls={creating ? 'create-roadmap-panel' : undefined}
              onClick={() => setCreating((value) => !value)}
            >
              {creating ? 'Hide create form' : 'Create roadmap'}
            </button>
          </div>
        )}
      </div>
      {!versions && !listError && <p role="status">Loading roadmaps…</p>}
      {listError && (
        <div>
          <p className="form-error" role="alert">
            {listError === 'denied'
              ? 'You do not have permission to view these roadmaps.'
              : 'Roadmaps could not be loaded.'}
          </p>
          {listError !== 'denied' && (
            <button
              type="button"
              className="workspace-button workspace-button-outline"
              onClick={() => {
                setListError('')
                setRetry((value) => value + 1)
              }}
            >
              Retry roadmaps
            </button>
          )}
        </div>
      )}
      {creating && (
        <section
          className="workspace-card roadmap-panel"
          id="create-roadmap-panel"
        >
          <h2>Create a roadmap draft</h2>
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <form className="learning-form" onSubmit={createDraft}>
            <label className="form-field">
              Roadmap name
              <input
                required
                minLength={2}
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Career readiness"
              />
            </label>
            <label className="form-field">
              Description
              <input
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this roadmap covers"
              />
            </label>
            <label className="form-field">
              Starter topics, one per line
              <textarea
                required
                rows={4}
                value={topics}
                onChange={(event) => setTopics(event.target.value)}
                placeholder={'Set goals\nBuild a portfolio'}
              />
            </label>
            <button className="workspace-button" disabled={busy}>
              {busy ? 'Creating…' : 'Create draft'}
            </button>
          </form>
        </section>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {versions && (
        <section className="roadmap-list" aria-label="Organization roadmaps">
          {roadmaps.length > 0 ? (
            <div className="roadmap-discovery-filters workspace-card">
              <label className="form-field">
                Search roadmaps
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Search by name or description"
                />
              </label>
              <label className="form-field">
                Latest version status (Active Roadmaps)
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="">All statuses</option>
                  {statuses.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="roadmap-result-count" role="status">
                {visibleRoadmaps.length} of {roadmaps.length} roadmaps
              </p>
            </div>
          ) : (
            <EmptyState
              title="No roadmaps yet"
              description="Choose Create roadmap to start your first learning path."
            />
          )}
          {roadmaps.length > 0 && !visibleRoadmaps.length && (
            <EmptyState
              title="No matching roadmaps"
              description="Try a different title or description."
            />
          )}
          <RoadmapLifecycleSections
            organizationId={organizationId}
            role={role}
            versions={versions}
            visibleRoadmaps={visibleRoadmaps}
            statusFilter={status}
            isSearching={Boolean(query)}
            createdDrafts={createdDrafts}
          />
        </section>
      )}
      {versions && <UploadedPlans organizationId={organizationId} />}
    </>
  )
}
