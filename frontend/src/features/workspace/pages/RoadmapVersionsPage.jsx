import { listPlans } from '../activityPlanApi'
import useUnsavedChanges from '../hooks/useUnsavedChanges'
import { outlineProblems } from '../outlineValidation'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { PageHeading } from '../components/WorkspaceUI'
import ForestLandscapeArtwork from '../components/ForestLandscapeArtwork'
import RoadmapStatusBadge from '../components/RoadmapStatusBadge'
import {
  archiveRoadmapVersion,
  copyRoadmapVersion,
  listOrganizations,
  listRoadmapVersions,
  saveRoadmapDraft,
  submitRoadmapVersion,
} from '../learningApi'

const editable = (phases) =>
  phases.map((phase) => ({
    title: phase.title,
    weeks: phase.weeks.map((week) => ({
      title: week.title,
      topics: week.topics.map((topic) => ({
        title: topic.title,
        description: topic.description,
      })),
    })),
  }))
const topicCount = (phases) =>
  phases.reduce(
    (total, phase) =>
      total + phase.weeks.reduce((sum, week) => sum + week.topics.length, 0),
    0,
  )
function shift(items, index, direction) {
  const next = index + direction
  if (next < 0 || next >= items.length) return
  ;[items[index], items[next]] = [items[next], items[index]]
}

export default function RoadmapVersionsPage() {
  const { roadmapId } = useParams()
  const [search] = useSearchParams()
  const preferredOrg = search.get('organizationId')
  const [organizationId, setOrganizationId] = useState('')
  const [organizationRole, setOrganizationRole] = useState('')
  const [sourcePlan, setSourcePlan] = useState(null)
  const [versions, setVersions] = useState([])
  const [activeId, setActiveId] = useState('')
  const [draft, setDraft] = useState([])
  const [dirty, setDirty] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [recovery, setRecovery] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const dialogRef = useRef(null)
  const submitTriggerRef = useRef(null)
  const submissionPendingRef = useRef(false)
  const selectedIdRef = useRef('')
  useUnsavedChanges(dirty)
  const active = versions.find((item) => item.version_id === activeId)
  const problems = outlineProblems(draft)
  const canSubmit = ['owner', 'admin', 'coordinator'].includes(organizationRole)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (confirmation) {
      if (!dialog.open) {
        if (dialog.showModal) dialog.showModal()
        else dialog.setAttribute('open', '')
      }
    } else if (dialog.open) {
      if (dialog.close) dialog.close()
      else dialog.removeAttribute('open')
      submitTriggerRef.current?.focus()
    }
  }, [confirmation])

  useEffect(() => {
    let mounted = true
    async function load() {
      try {
        const organizations = await listOrganizations()
        const candidates = preferredOrg
          ? organizations.filter((item) => item.id === preferredOrg)
          : organizations
        for (const organization of candidates) {
          try {
            const rows = await listRoadmapVersions(organization.id, roadmapId)
            if (!mounted) return
            setOrganizationId(organization.id)
            setOrganizationRole(organization.role)
            setVersions(rows)
            const chosen = rows.at(-1)
            setActiveId(chosen?.version_id || '')
            selectedIdRef.current = chosen?.version_id || ''
            setDraft(chosen ? editable(chosen.phases) : [])
            setLoading(false)
            return
          } catch {
            /* Try another authorized organization for direct links. */
          }
        }
        if (mounted) setError('Roadmap not found or access denied.')
      } catch (cause) {
        if (mounted) setError(cause.message)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [preferredOrg, roadmapId])

  useEffect(() => {
    if (!organizationId) return
    let live = true
    listPlans(organizationId)
      .then((result) => {
        if (live)
          setSourcePlan(result.plans.find((p) => p.roadmap_id === roadmapId))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [organizationId, roadmapId])
  function selectVersion(version) {
    if (busy || confirmation) return
    if (dirty) {
      setError('Save your draft before switching versions.')
      return
    }
    setActiveId(version.version_id)
    selectedIdRef.current = version.version_id
    setDraft(editable(version.phases))
    setDirty(false)
    setReviewing(false)
    setMessage('')
    setError('')
    setRecovery(null)
  }
  function change(mutator) {
    setDraft((current) => {
      const next = structuredClone(current)
      mutator(next)
      return next
    })
    setDirty(true)
    setReviewing(false)
  }
  function replaceVersion(updated) {
    setVersions((current) =>
      current.map((item) =>
        item.version_id === updated.version_id ? updated : item,
      ),
    )
    setActiveId(updated.version_id)
    selectedIdRef.current = updated.version_id
    setDraft(editable(updated.phases))
    setDirty(false)
    setReviewing(false)
    setRecovery(null)
  }
  function requireRevision(version) {
    if (Number.isInteger(version?.revision) && version.revision >= 0)
      return version.revision
    setError(
      'This version needs current server information before you can continue.',
    )
    setRecovery({ kind: 'missing', latest: null })
    return null
  }
  async function refreshVersions(selectedId, preserveDraft = false) {
    const rows = await listRoadmapVersions(organizationId, roadmapId)
    const selected = rows.find((item) => item.version_id === selectedId)
    if (!selected)
      throw new Error(
        'The selected version is no longer available. Reload the page to continue.',
      )
    if (preserveDraft) {
      setRecovery({ kind: 'save', latest: selected })
    } else {
      setVersions(rows)
      setActiveId(selectedId)
      selectedIdRef.current = selectedId
      setDraft(editable(selected.phases))
      setDirty(false)
      setReviewing(false)
      setRecovery(null)
    }
    return selected
  }
  async function reviewLatest() {
    setBusy(true)
    setError('')
    try {
      await refreshVersions(activeId, dirty)
      setMessage('Current server version loaded for review.')
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }
  function keepEditsOnLatest() {
    const latest = recovery?.latest
    if (!latest || latest.version_id !== activeId) return
    setVersions((current) =>
      current.map((item) => (item.version_id === activeId ? latest : item)),
    )
    setRecovery(null)
    setError('')
    setMessage(
      'Your edits are retained. Review them against the latest version before saving.',
    )
  }
  async function save() {
    const revision = requireRevision(active)
    if (revision === null || recovery) return
    setBusy(true)
    setError('')
    try {
      replaceVersion(
        await saveRoadmapDraft(
          organizationId,
          roadmapId,
          active.version_id,
          draft,
          revision,
        ),
      )
      await refreshVersions(active.version_id)
      setMessage('Draft saved. Review it before submitting for review.')
    } catch (cause) {
      if (cause.status === 409) {
        setRecovery({ kind: 'save', latest: null })
        setError(
          'Roadmap changed. Someone updated this roadmap while you were editing. Your unsaved changes are still available.',
        )
      } else setError(cause.message)
    } finally {
      setBusy(false)
    }
  }
  function openSubmission() {
    if (dirty) {
      setError(
        'Save your changes first. Save the latest roadmap changes before submitting this version for review.',
      )
      return
    }
    if (
      !canSubmit ||
      active?.status !== 'draft' ||
      busy ||
      recovery ||
      problems.length
    )
      return
    const revision = requireRevision(active)
    if (revision === null) return
    setError('')
    setConfirmation({ organizationId, versionId: active.version_id, revision })
  }
  async function submit() {
    if (submissionPendingRef.current || !confirmation) return
    const { organizationId: confirmedOrg, versionId, revision } = confirmation
    if (
      confirmedOrg !== organizationId ||
      versionId !== active?.version_id ||
      revision !== active.revision ||
      active.status !== 'draft' ||
      !canSubmit ||
      dirty ||
      busy ||
      recovery ||
      problems.length
    ) {
      setConfirmation(null)
      setError(
        'This draft changed before submission. Review and confirm it again.',
      )
      return
    }
    submissionPendingRef.current = true
    setBusy(true)
    setError('')
    let submitted
    try {
      submitted = await submitRoadmapVersion(
        organizationId,
        roadmapId,
        versionId,
        revision,
      )
    } catch (cause) {
      if (cause.status === 409) {
        setRecovery({ kind: 'mutation', latest: null })
        setError(
          'This draft changed or was already submitted. Refresh it before trying again.',
        )
      } else if (cause.status === 401) {
        setError(
          'Your session has expired. Sign in again before submitting this version.',
        )
      } else if (cause.status === 403) {
        setError('You do not have permission to submit this roadmap version.')
      } else if (cause.status === 422) {
        setError(cause.message)
      } else {
        setRecovery({ kind: 'mutation', latest: null })
        setError(
          'Submission could not be confirmed. Refresh the version to check its current status before trying again.',
        )
      }
      setConfirmation(null)
      return
    } finally {
      setBusy(false)
      submissionPendingRef.current = false
    }
    setConfirmation(null)
    setVersions((current) =>
      current.map((item) => (item.version_id === versionId ? submitted : item)),
    )
    if (selectedIdRef.current === versionId) {
      setDraft(editable(submitted.phases))
      setDirty(false)
      setReviewing(false)
    }
    setMessage(
      'Submitted for review. This roadmap version is now awaiting review by an Owner or Admin.',
    )
    try {
      const rows = await listRoadmapVersions(organizationId, roadmapId)
      const selected = rows.find((item) => item.version_id === versionId)
      if (!selected)
        throw new Error(
          'Submitted version was not found in the refreshed list.',
        )
      if (
        selected.status !== 'in_review' ||
        selected.revision < submitted.revision
      )
        throw new Error(
          'The refreshed list has not caught up with the submission.',
        )
      setVersions(rows)
      if (selectedIdRef.current === versionId)
        setDraft(editable(selected.phases))
    } catch {
      setRecovery({ kind: 'mutation', latest: null })
      setError(
        'Submission succeeded, but the latest version list could not be loaded. Refresh version information to confirm its current state.',
      )
    }
  }
  async function archive() {
    const revision = requireRevision(active)
    if (revision === null || recovery) return
    if (
      versions.filter((item) => item.status === 'published').length === 1 &&
      !window.confirm(
        'This is the only published version in the current list. Archive it?',
      )
    )
      return
    setBusy(true)
    setError('')
    try {
      const updated = await archiveRoadmapVersion(
        organizationId,
        roadmapId,
        active.version_id,
        revision,
      )
      replaceVersion(updated)
      await refreshVersions(updated.version_id)
      setMessage(
        'Version archived. Existing cohorts still use this exact version.',
      )
    } catch (cause) {
      if (cause.status === 409) {
        setRecovery({ kind: 'mutation', latest: null })
        setError(
          'This version changed on the server. Refresh it before trying to archive again.',
        )
      } else setError(cause.message)
    } finally {
      setBusy(false)
    }
  }
  async function copy() {
    const revision = requireRevision(active)
    if (revision === null || recovery) return
    setBusy(true)
    setError('')
    try {
      const next = await copyRoadmapVersion(
        organizationId,
        roadmapId,
        active.version_id,
        revision,
      )
      await refreshVersions(next.version_id)
      setMessage(
        `Draft v${next.version_number} created with independent topic IDs.`,
      )
    } catch (cause) {
      if (cause.status === 409) {
        setRecovery({ kind: 'mutation', latest: null })
        setError(
          'The source version changed on the server. Refresh it before trying to copy again.',
        )
      } else setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="roadmap-page-header">
        <ForestLandscapeArtwork />
        <PageHeading
          eyebrow="Coordinator / Roadmaps / Versions"
          title={active?.name || 'Roadmap versions'}
          description="Create and manage roadmap drafts, submit them for review, and track publication status."
        />
      </div>
      <div className="roadmap-backlinks">
        <Link className="workspace-text-link" to="/app/coordinator/roadmaps">
          ← All roadmaps
        </Link>
        {(search.get('activityPlanId') || sourcePlan) && (
          <Link
            className="workspace-text-link"
            to={`/app/coordinator/activity-plans/${search.get('activityPlanId') || sourcePlan.id}?organizationId=${organizationId || preferredOrg}`}
          >
            View source and review decisions
          </Link>
        )}
      </div>
      {loading && <p role="status">Loading version history…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {recovery && (
        <section className="workspace-card" aria-label="Version recovery">
          <h2>
            {recovery.kind === 'save'
              ? 'Roadmap changed'
              : 'Refresh version information'}
          </h2>
          <p>
            {dirty
              ? 'Your unsaved edits remain in the editor.'
              : 'Reload the current version before trying the action again.'}
          </p>
          <button
            type="button"
            className="workspace-button workspace-button-outline"
            disabled={busy}
            onClick={reviewLatest}
          >
            Review latest version
          </button>
          {recovery.latest && dirty && (
            <>
              <div
                className="roadmap-readonly"
                aria-label="Latest server version"
              >
                <h3>Latest server version</h3>
                {recovery.latest.phases.map((phase, index) => (
                  <section key={phase.id || index}>
                    <h4>{phase.title}</h4>
                    {phase.weeks.map((week, weekIndex) => (
                      <div key={week.id || weekIndex}>
                        <strong>{week.title}</strong>
                        <ul>
                          {week.topics.map((topic, topicIndex) => (
                            <li key={topic.id || topicIndex}>{topic.title}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
              <button
                type="button"
                className="workspace-button"
                onClick={keepEditsOnLatest}
              >
                Keep editing with latest revision
              </button>
              <button
                type="button"
                className="workspace-button workspace-button-outline"
                onClick={() => replaceVersion(recovery.latest)}
              >
                Use latest version and discard my edits
              </button>
            </>
          )}
        </section>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      <dialog
        ref={dialogRef}
        className="roadmap-submit-dialog"
        aria-labelledby="roadmap-submit-title"
        aria-describedby="roadmap-submit-description"
        onCancel={(event) => {
          if (busy) event.preventDefault()
          else setConfirmation(null)
        }}
      >
        <div className="roadmap-submit-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m3 11 17-8-6 18-3-8-8-2Z" />
            <path d="m11 13 9-10" />
          </svg>
        </div>
        <h2 id="roadmap-submit-title">Submit roadmap for review?</h2>
        <p id="roadmap-submit-description">
          This version will become read-only until an Owner or Admin approves or
          rejects it.
        </p>
        <div className="roadmap-submit-dialog-actions">
          <button
            type="button"
            className="workspace-button workspace-button-outline"
            disabled={busy}
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="workspace-button"
            disabled={busy}
            onClick={submit}
          >
            {busy ? 'Submitting…' : 'Submit for Review'}
          </button>
        </div>
      </dialog>
      {!!versions.length && (
        <div className="roadmap-version-layout">
          <aside
            className="workspace-card roadmap-version-list"
            aria-label="Version history"
          >
            <h2>Version history</h2>
            <label className="mobile-version-select">
              Version
              <select
                value={activeId}
                disabled={busy}
                onChange={(e) =>
                  selectVersion(
                    versions.find((v) => v.version_id === e.target.value),
                  )
                }
              >
                {versions.map((v) => (
                  <option key={v.version_id} value={v.version_id}>
                    Version {v.version_number} · {v.status}
                  </option>
                ))}
              </select>
            </label>
            {versions.map((version) => (
              <button
                type="button"
                key={version.version_id}
                className={`roadmap-version-choice ${version.version_id === activeId ? 'is-active' : ''}`}
                aria-pressed={version.version_id === activeId}
                disabled={busy}
                onClick={() => selectVersion(version)}
              >
                <strong>Version {version.version_number}</strong>
                <span className="roadmap-version-choice-meta">
                  <RoadmapStatusBadge status={version.status} />
                  <span>{version.topics.length} topics</span>
                </span>
              </button>
            ))}
          </aside>
          {active && (
            <section className="workspace-card roadmap-editor">
              <div className="roadmap-editor-heading">
                <div>
                  <p className="workspace-card-label">
                    Version {active.version_number}
                  </p>
                  <RoadmapStatusBadge status={active.status} />
                  <h2>{active.name}</h2>
                  <p>{active.description || 'No description.'}</p>
                </div>
                <button
                  type="button"
                  className="workspace-button workspace-button-outline"
                  disabled={busy || dirty || active.status === 'draft'}
                  onClick={copy}
                >
                  Copy as new draft
                </button>
              </div>
              {active.status === 'draft' ? (
                <>
                  <p>
                    Edit phase, week, and topic titles below. Save the ordered
                    draft before review.
                  </p>
                  <fieldset className="plan-fieldset" disabled={busy}>
                    {draft.map((phase, phaseIndex) => (
                      <details
                        open={phaseIndex === 0 || !phase.title}
                        className="roadmap-phase"
                        key={phaseIndex}
                      >
                        <summary>
                          {phase.title || 'Untitled phase'} ·{' '}
                          {phase.weeks.length} weeks
                        </summary>
                        <div className="roadmap-edit-row">
                          <label className="form-field">
                            <span>Phase {phaseIndex + 1}</span>
                            <input
                              value={phase.title}
                              maxLength={200}
                              onChange={(event) =>
                                change((next) => {
                                  next[phaseIndex].title = event.target.value
                                })
                              }
                            />
                          </label>
                          <button
                            type="button"
                            aria-label={`Move ${phase.title || 'phase'} up`}
                            disabled={phaseIndex === 0}
                            onClick={() =>
                              change((next) => shift(next, phaseIndex, -1))
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${phase.title || 'phase'} down`}
                            disabled={phaseIndex === draft.length - 1}
                            onClick={() =>
                              change((next) => shift(next, phaseIndex, 1))
                            }
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              window.confirm(
                                'Remove this phase and all its topics?',
                              ) && change((next) => next.splice(phaseIndex, 1))
                            }
                          >
                            Remove phase
                          </button>
                        </div>
                        {phase.weeks.map((week, weekIndex) => (
                          <details
                            open={
                              (phaseIndex === 0 && weekIndex === 0) ||
                              !week.title
                            }
                            className="roadmap-week"
                            key={weekIndex}
                          >
                            <summary>
                              {week.title || 'Untitled week'} ·{' '}
                              {week.topics.length} topics
                            </summary>
                            <div className="roadmap-edit-row">
                              <label className="form-field">
                                <span>Week {weekIndex + 1}</span>
                                <input
                                  value={week.title}
                                  maxLength={200}
                                  onChange={(event) =>
                                    change((next) => {
                                      next[phaseIndex].weeks[weekIndex].title =
                                        event.target.value
                                    })
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                aria-label={`Move ${week.title || 'week'} up`}
                                disabled={weekIndex === 0}
                                onClick={() =>
                                  change((next) =>
                                    shift(
                                      next[phaseIndex].weeks,
                                      weekIndex,
                                      -1,
                                    ),
                                  )
                                }
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${week.title || 'week'} down`}
                                disabled={weekIndex === phase.weeks.length - 1}
                                onClick={() =>
                                  change((next) =>
                                    shift(next[phaseIndex].weeks, weekIndex, 1),
                                  )
                                }
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  window.confirm(
                                    'Remove this week and all its topics?',
                                  ) &&
                                  change((next) =>
                                    next[phaseIndex].weeks.splice(weekIndex, 1),
                                  )
                                }
                              >
                                Remove week
                              </button>
                            </div>
                            {week.topics.map((topic, topicIndex) => (
                              <div
                                className="roadmap-edit-row roadmap-topic"
                                key={topicIndex}
                              >
                                <label className="form-field">
                                  <span>Topic {topicIndex + 1}</span>
                                  <input
                                    value={topic.title}
                                    maxLength={200}
                                    onChange={(event) =>
                                      change((next) => {
                                        next[phaseIndex].weeks[
                                          weekIndex
                                        ].topics[topicIndex].title =
                                          event.target.value
                                      })
                                    }
                                  />
                                </label>
                                <label className="form-field">
                                  <span>Description</span>
                                  <textarea
                                    rows={3}
                                    value={topic.description}
                                    maxLength={1000}
                                    onChange={(event) =>
                                      change((next) => {
                                        next[phaseIndex].weeks[
                                          weekIndex
                                        ].topics[topicIndex].description =
                                          event.target.value
                                      })
                                    }
                                  />
                                </label>
                                <button
                                  type="button"
                                  aria-label={`Move ${topic.title || 'topic'} up`}
                                  disabled={topicIndex === 0}
                                  onClick={() =>
                                    change((next) =>
                                      shift(
                                        next[phaseIndex].weeks[weekIndex]
                                          .topics,
                                        topicIndex,
                                        -1,
                                      ),
                                    )
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Move ${topic.title || 'topic'} down`}
                                  disabled={
                                    topicIndex === week.topics.length - 1
                                  }
                                  onClick={() =>
                                    change((next) =>
                                      shift(
                                        next[phaseIndex].weeks[weekIndex]
                                          .topics,
                                        topicIndex,
                                        1,
                                      ),
                                    )
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    window.confirm('Remove this topic?') &&
                                    change((next) =>
                                      next[phaseIndex].weeks[
                                        weekIndex
                                      ].topics.splice(topicIndex, 1),
                                    )
                                  }
                                >
                                  Remove topic
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              disabled={
                                week.topics.length >= 24 ||
                                topicCount(draft) >= 500
                              }
                              onClick={() =>
                                change((next) =>
                                  next[phaseIndex].weeks[weekIndex].topics.push(
                                    {
                                      title: '',
                                      description: '',
                                    },
                                  ),
                                )
                              }
                            >
                              + Add topic
                            </button>
                          </details>
                        ))}
                        <button
                          type="button"
                          disabled={phase.weeks.length >= 52}
                          onClick={() =>
                            change((next) =>
                              next[phaseIndex].weeks.push({
                                title: '',
                                topics: [],
                              }),
                            )
                          }
                        >
                          + Add week
                        </button>
                      </details>
                    ))}
                  </fieldset>
                  {problems.length > 0 && (
                    <section
                      className="outline-validation"
                      aria-label="Outline needs attention"
                    >
                      <h3>Complete the outline before saving</h3>
                      <ul>
                        {problems.map((problem) => (
                          <li key={problem}>{problem}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <div className="roadmap-actions plan-save-bar">
                    <p role="status">
                      {busy
                        ? 'Saving…'
                        : error && dirty
                          ? 'Save failed'
                          : dirty
                            ? 'Unsaved changes — save before review.'
                            : 'Saved'}
                    </p>
                    <button
                      type="button"
                      disabled={busy || draft.length >= 12}
                      onClick={() =>
                        change((next) => next.push({ title: '', weeks: [] }))
                      }
                    >
                      + Add phase
                    </button>
                    <button
                      type="button"
                      className="workspace-button"
                      disabled={
                        busy || !!recovery || !dirty || problems.length > 0
                      }
                      onClick={save}
                    >
                      Save draft
                    </button>
                    <button
                      type="button"
                      className="workspace-button workspace-button-outline"
                      disabled={
                        busy || !!recovery || dirty || problems.length > 0
                      }
                      onClick={() => setReviewing(true)}
                    >
                      Review draft
                    </button>
                  </div>
                  {reviewing && (
                    <div
                      className="roadmap-review"
                      role="region"
                      aria-label="Draft review"
                    >
                      <h3>Draft review</h3>
                      {!!sourcePlan?.warnings?.length && (
                        <aside
                          className="source-warning"
                          aria-label="Source review notes"
                        >
                          <h4>Source review notes</h4>
                          <p>
                            These extraction notes were checked during import.
                            Compare the saved draft with the original before
                            submitting it for review.
                          </p>
                          <ul>
                            {sourcePlan.warnings.map((warning) => (
                              <li key={warning.id}>
                                {warning.message} · Page {warning.page_number}
                              </li>
                            ))}
                          </ul>
                          <Link
                            to={`/app/coordinator/activity-plans/${sourcePlan.id}?organizationId=${organizationId}`}
                          >
                            View source and decisions
                          </Link>
                        </aside>
                      )}
                      <div className="roadmap-readonly">
                        {draft.map((phase, pi) => (
                          <section key={pi}>
                            <h3>{phase.title}</h3>
                            {phase.weeks.map((week, wi) => (
                              <section key={wi}>
                                <h4>{week.title}</h4>
                                <ol>
                                  {week.topics.map((topic, ti) => (
                                    <li key={ti}>
                                      <strong>{topic.title}</strong>
                                      <p>{topic.description}</p>
                                    </li>
                                  ))}
                                </ol>
                              </section>
                            ))}
                          </section>
                        ))}
                      </div>
                      <p>
                        {draft.length} phases ·{' '}
                        {draft.reduce(
                          (sum, phase) => sum + phase.weeks.length,
                          0,
                        )}{' '}
                        weeks · {topicCount(draft)} topics.
                      </p>
                      <p>
                        Submitting makes this version read-only until an Owner
                        or Admin approves or rejects it.
                      </p>
                    </div>
                  )}
                  {canSubmit && (
                    <button
                      ref={submitTriggerRef}
                      type="button"
                      className="workspace-button roadmap-submit-trigger"
                      disabled={
                        busy || !!recovery || dirty || problems.length > 0
                      }
                      onClick={openSubmission}
                    >
                      Submit for Review
                    </button>
                  )}
                  {canSubmit && dirty && (
                    <p role="status">
                      Save your changes first before submitting for review.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {active.status === 'in_review' && (
                    <aside className="roadmap-in-review-notice">
                      <strong>This version is under review.</strong>
                      <p>
                        Its content is read-only until an Owner or Admin
                        approves or rejects the submission.
                      </p>
                    </aside>
                  )}
                  <div className="roadmap-readonly">
                    {active.phases.map((phase) => (
                      <div key={phase.id} className="roadmap-phase">
                        <h3>{phase.title}</h3>
                        {phase.weeks.map((week) => (
                          <div key={week.id} className="roadmap-week">
                            <h4>{week.title}</h4>
                            <ol>
                              {week.topics.map((topic) => (
                                <li key={topic.id}>
                                  <strong>{topic.title}</strong>
                                  {topic.description && (
                                    <p>{topic.description}</p>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {active.status === 'published' && (
                    <Link
                      className="workspace-button"
                      to={`/app/coordinator/learning?organizationId=${encodeURIComponent(organizationId)}&roadmapVersionId=${encodeURIComponent(active.version_id)}#cohort-setup`}
                    >
                      Assign to cohort
                    </Link>
                  )}
                  {active.status === 'published' && (
                    <button
                      type="button"
                      className="workspace-button workspace-button-outline"
                      disabled={busy}
                      onClick={archive}
                    >
                      Archive version
                    </button>
                  )}
                  {active.status === 'archived' && (
                    <p>
                      This version is archived. Assigned cohorts and their
                      progress remain available.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </>
  )
}
