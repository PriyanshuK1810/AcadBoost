import { listPlans } from '../activityPlanApi'
import useUnsavedChanges from '../hooks/useUnsavedChanges'
import { outlineProblems } from '../outlineValidation'
import { useContext, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router'
import { WorkspaceContext } from '../hooks/useWorkspace'
import { learningRoles, withOrganization } from '../hooks/useOrganizationScope'
import LiveResourceState from '../components/LiveResourceState'
import { PageHeading } from '../components/WorkspaceUI'
import ForestLandscapeArtwork from '../components/ForestLandscapeArtwork'
import RoadmapStatusBadge from '../components/RoadmapStatusBadge'
import RoadmapReviewHistory from '../components/RoadmapReviewHistory'
import {
  approveRoadmapVersion,
  archiveRoadmapVersion,
  copyRoadmapVersion,
  listOrganizations,
  listRoadmapVersions,
  rejectRoadmapVersion,
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
const formatVersionDate = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}
const versionMetadata = (version, reviewState) => {
  const status = version.status
  const pendingSubmission = version.pending_submission
  const activityDate = version.updated_at
    ? { label: 'Updated', value: version.updated_at }
    : status === 'in_review' && pendingSubmission?.submitted_at
      ? { label: 'Submitted', value: pendingSubmission.submitted_at }
      : ['published', 'archived'].includes(status) && version.published_at
        ? { label: 'Published', value: version.published_at }
        : { label: 'Created', value: version.created_at }

  return [
    {
      label: 'Revision',
      value: Number.isInteger(version.revision)
        ? `Rev. ${version.revision}`
        : '—',
    },
    { label: activityDate.label, value: formatVersionDate(activityDate.value) },
    {
      label: 'Submission state',
      value:
        status === 'draft'
          ? 'No active submission'
          : ['in_review', 'published', 'archived'].includes(status)
            ? 'Submitted'
            : 'Not available',
    },
    {
      label: 'Review state',
      value: reviewState,
    },
  ]
}
function VersionMetadata({ version, reviewState }) {
  return (
    <dl className="roadmap-version-metadata" aria-label="Version metadata">
      {versionMetadata(version, reviewState).map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function shift(items, index, direction) {
  const next = index + direction
  if (next < 0 || next >= items.length) return
  ;[items[index], items[next]] = [items[next], items[index]]
}

const rejectionLimit = 2000
const decisionErrors = {
  401: 'Your session has expired. Sign in again before reviewing this version.',
  403: 'You do not have permission to decide this roadmap review.',
  404: 'This version or submission is no longer available. Refresh its status.',
  409: 'Review changed. This version was updated or reviewed by someone else. Refresh its status before making another decision.',
  422: 'The server rejected the review details. Check the information before trying again.',
  500: 'The server could not confirm the decision. Refresh the version before trying again.',
}
function decisionErrorMessage(cause, fallback) {
  const text =
    fallback ||
    decisionErrors[cause.status] ||
    'The decision outcome could not be confirmed. Refresh the version before trying again.'
  const requestId = cause.request_id
  return typeof requestId === 'string' && /^[\w-]{1,80}$/.test(requestId)
    ? `${text} Reference: ${requestId}.`
    : text
}
function pendingDecision(version) {
  const pending = version?.pending_submission
  if (
    version?.status !== 'in_review' ||
    !Number.isInteger(version.revision) ||
    version.revision < 1 ||
    version.revision > 2147483647 ||
    pending?.decision !== 'pending' ||
    pending.version_id !== version.version_id ||
    pending.submitted_revision !== version.revision ||
    typeof pending.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      pending.id,
    )
  )
    return null
  return pending.id
}

export default function RoadmapVersionsPage() {
  const { roadmapId } = useParams()
  const [search] = useSearchParams()
  const preferredOrg = search.get('organizationId')
  const preferredVersion = search.get('versionId')
  const location = useLocation()
  const showFeedback = location.hash === '#roadmap-review-feedback'
  const scope = useContext(WorkspaceContext)?.organizationScope
  if (scope?.loading || scope?.error) return <LiveResourceState {...scope} />
  return (
    <RoadmapVersionWorkspace
      key={JSON.stringify([roadmapId, preferredOrg, preferredVersion])}
      roadmapId={roadmapId}
      search={search}
      preferredOrg={preferredOrg}
      preferredVersion={preferredVersion}
      showFeedback={showFeedback}
      memberships={scope?.organizations}
      address={location.pathname + location.search + location.hash}
    />
  )
}

function RoadmapVersionWorkspace({
  roadmapId,
  search,
  preferredOrg,
  preferredVersion,
  showFeedback,
  memberships,
  address,
}) {
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
  const [decision, setDecision] = useState(null)
  const [decisionError, setDecisionError] = useState('')
  const [decisionBlocks, setDecisionBlocks] = useState({})
  const [rejectionReasons, setRejectionReasons] = useState({})
  const dialogRef = useRef(null)
  const submitTriggerRef = useRef(null)
  const decisionDialogRef = useRef(null)
  const decisionTriggerRef = useRef(null)
  const decisionPendingRef = useRef(false)
  const versionHeadingRef = useRef(null)
  const feedbackRef = useRef(null)
  const mountedRef = useRef(false)
  const submissionPendingRef = useRef(false)
  const selectedIdRef = useRef('')
  useUnsavedChanges(dirty)
  const active = versions.find((item) => item.version_id === activeId)
  const problems = outlineProblems(draft)
  const canSubmit = ['owner', 'admin', 'coordinator'].includes(organizationRole)
  const canCopy =
    canSubmit && ['published', 'archived'].includes(active?.status)
  const isReviewer = ['owner', 'admin'].includes(organizationRole)
  const showDecisions = isReviewer && active?.status === 'in_review'
  const submissionId = pendingDecision(active)
  const blockedDecision = decisionBlocks[activeId]
  const reason = rejectionReasons[decision?.versionId || activeId] || ''
  const reasonValid =
    reason.trim().length > 0 && reason.length <= rejectionLimit

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const dialog = decisionDialogRef.current
    if (decision && !dialog.open) {
      if (dialog.showModal) dialog.showModal()
      else dialog.setAttribute('open', '')
      dialog.querySelector('textarea, [data-decision-cancel]')?.focus()
    } else if (!decision && dialog.open) {
      if (dialog.close) dialog.close()
      else dialog.removeAttribute('open')
      const trigger = decisionTriggerRef.current
      if (trigger?.isConnected && !trigger.disabled) trigger.focus()
      else versionHeadingRef.current?.focus()
    }
  }, [decision])

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
        const organizations = memberships ?? await listOrganizations()
        const candidates = preferredOrg !== null
          ? organizations.filter((item) => item.id === preferredOrg)
          : organizations
        for (const organization of candidates) {
          if (!mounted) return
          if (memberships && !learningRoles.includes(organization.role)) continue
          try {
            const loaded = await listRoadmapVersions(organization.id, roadmapId)
            const rows = preferredVersion === null && !memberships
              ? loaded
              : loaded.filter((row) => row.id === roadmapId && row.organization_id === organization.id)
            if (memberships && !rows.length) continue
            if (!mounted) return
            setOrganizationId(organization.id)
            setOrganizationRole(organization.role)
            setVersions(rows)
            const chosen = preferredVersion === null
              ? rows.at(-1)
              : rows.find((row) => row.version_id === preferredVersion)
            if (preferredVersion !== null && !chosen) {
              setError('The requested roadmap version is unavailable. Select an available version below.')
            }
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
  }, [memberships, preferredOrg, preferredVersion, roadmapId])

  const feedbackSelected = showFeedback && !!active && active.version_id === preferredVersion
  useEffect(() => {
    if (!feedbackSelected || !feedbackRef.current) return
    feedbackRef.current.focus()
    feedbackRef.current.scrollIntoView?.({ block: 'start' })
  }, [feedbackSelected])

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
    if (!version || busy || confirmation || decisionPendingRef.current) return
    if (dirty) {
      setError('Save your draft before switching versions.')
      return
    }
    setDecision(null)
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
  async function refreshVersions(
    selectedId,
    preserveDraft = false,
    decisionFloor = decisionBlocks[selectedId]?.outcome,
  ) {
    const rows = await listRoadmapVersions(organizationId, roadmapId)
    if (!mountedRef.current) return
    const selected = rows.find((item) => item.version_id === selectedId)
    if (!selected)
      throw new Error(
        'The selected version is no longer available. Reload the page to continue.',
      )
    if (
      decisionFloor &&
      (!Number.isInteger(selected.revision) ||
        selected.revision < decisionFloor.revision ||
        (selected.revision === decisionFloor.revision &&
          selected.status !== decisionFloor.status))
    ) {
      throw new Error('The version list has not caught up with the decision.')
    }
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

  function openDecision(kind, trigger) {
    if (
      !showDecisions ||
      !submissionId ||
      busy ||
      recovery ||
      blockedDecision ||
      decision ||
      confirmation ||
      decisionPendingRef.current
    )
      return
    decisionTriggerRef.current = trigger
    setDecisionError('')
    setError('')
    setMessage('')
    setDecision({
      kind,
      versionId: active.version_id,
      revision: active.revision,
      submissionId,
      name: active.name,
      versionNumber: active.version_number,
    })
  }

  async function refreshDecision() {
    if (busy || decisionPendingRef.current) return
    const versionId = activeId
    setBusy(true)
    setError('')
    try {
      await refreshVersions(versionId)
      setDecisionBlocks((blocks) => ({ ...blocks, [versionId]: undefined }))
      setMessage(
        'Current server version loaded. Review its status before making a new decision.',
      )
    } catch (cause) {
      setError(
        decisionErrorMessage(
          cause,
          'Current review information could not be loaded. Try refreshing again.',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  async function confirmDecision(event) {
    event.preventDefault()
    if (!decision || busy || decisionPendingRef.current) return
    const {
      kind,
      versionId,
      revision,
      submissionId: confirmedSubmissionId,
    } = decision
    if (
      !showDecisions ||
      activeId !== versionId ||
      active.revision !== revision ||
      submissionId !== confirmedSubmissionId ||
      blockedDecision ||
      recovery
    ) {
      setDecision(null)
      setError(
        'This review changed before confirmation. Check the selected version and start a new decision.',
      )
      return
    }
    if (kind === 'reject' && !reasonValid) return

    decisionPendingRef.current = true
    setBusy(true)
    setDecisionError('')
    const args = [
      organizationId,
      roadmapId,
      versionId,
      revision,
      confirmedSubmissionId,
    ]
    const outcome = kind === 'approve' ? 'published' : 'draft'
    try {
      const updated =
        kind === 'approve'
          ? await approveRoadmapVersion(...args)
          : await rejectRoadmapVersion(...args, reason.trim())
      if (!mountedRef.current || selectedIdRef.current !== versionId) return
      if (
        updated?.version_id !== versionId ||
        updated.status !== outcome ||
        !Number.isInteger(updated.revision) ||
        updated.revision < revision ||
        !Array.isArray(updated.phases)
      ) {
        throw new Error('Unexpected decision response')
      }
      replaceVersion(updated)
      setRejectionReasons((reasons) => ({ ...reasons, [versionId]: '' }))
      setMessage(
        kind === 'approve'
          ? 'Approved and published. This roadmap version is ready for learners.'
          : 'Version rejected and returned to Draft for revision.',
      )
      try {
        await refreshVersions(versionId, false, updated)
      } catch (cause) {
        if (!mountedRef.current || selectedIdRef.current !== versionId) return
        setDecisionBlocks((blocks) => ({
          ...blocks,
          [versionId]: {
            message: decisionErrorMessage(
              cause,
              'The decision succeeded, but the latest version list could not be loaded. Refresh its status.',
            ),
            outcome: { revision: updated.revision, status: updated.status },
          },
        }))
      }
      setDecision(null)
    } catch (cause) {
      if (!mountedRef.current || selectedIdRef.current !== versionId) return
      const text = decisionErrorMessage(cause)
      if ([401, 403, 422].includes(cause.status)) {
        setDecisionError(text)
      } else {
        setDecisionBlocks((blocks) => ({
          ...blocks,
          [versionId]: { message: text },
        }))
        setDecision(null)
      }
    } finally {
      decisionPendingRef.current = false
      if (mountedRef.current) setBusy(false)
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
      setBusy(false)
      submissionPendingRef.current = false
      return
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
    } finally {
      setBusy(false)
      submissionPendingRef.current = false
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
    if (!canCopy || busy || dirty || recovery) return
    const revision = requireRevision(active)
    if (revision === null) return
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

  if (memberships && preferredOrg === null && organizationId) {
    return <Navigate replace to={withOrganization(address, organizationId)} />
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
        <Link
          className="workspace-text-link"
          to={{
            pathname: '/app/coordinator/roadmaps',
            search: organizationId || preferredOrg
              ? '?' + new URLSearchParams({ organizationId: organizationId || preferredOrg })
              : '',
          }}
        >
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
      <dialog
        ref={decisionDialogRef}
        className="roadmap-submit-dialog roadmap-decision-dialog"
        aria-labelledby="roadmap-decision-title"
        aria-describedby="roadmap-decision-description roadmap-decision-version"
        onCancel={(event) => {
          event.preventDefault()
          if (!decisionPendingRef.current) setDecision(null)
        }}
      >
        {decision && (
          <form onSubmit={confirmDecision} aria-busy={busy}>
            <h2 id="roadmap-decision-title">
              {decision.kind === 'approve'
                ? 'Approve and publish this version?'
                : 'Reject this roadmap version?'}
            </h2>
            <p id="roadmap-decision-version">
              <strong>{decision.name}</strong> · Version{' '}
              {decision.versionNumber}
            </p>
            <p id="roadmap-decision-description">
              {decision.kind === 'approve'
                ? 'This will publish the reviewed roadmap version. Confirm that its content is ready for learners.'
                : 'The version will return to Draft so it can be revised and submitted again. Provide actionable feedback explaining what needs to change.'}
            </p>
            {decision.kind === 'reject' && (
              <div className="form-field">
                <label htmlFor="roadmap-rejection-reason">
                  Reason for rejection
                </label>
                <textarea
                  id="roadmap-rejection-reason"
                  rows={5}
                  required
                  maxLength={rejectionLimit}
                  readOnly={busy}
                  value={reason}
                  aria-invalid={!!reason && !reasonValid}
                  aria-describedby="roadmap-rejection-count roadmap-rejection-validation"
                  onChange={(event) => {
                    const value = event.target.value
                    setRejectionReasons((reasons) => ({
                      ...reasons,
                      [decision.versionId]: value,
                    }))
                    setDecisionError('')
                  }}
                />
                <small id="roadmap-rejection-count">
                  {reason.length.toLocaleString('en-US')} / 2,000
                </small>
                <small id="roadmap-rejection-validation">
                  {reason.length > rejectionLimit
                    ? 'Use 2,000 characters or fewer.'
                    : !reason.trim()
                      ? 'Enter actionable feedback to continue.'
                      : ''}
                </small>
              </div>
            )}
            {decisionError && (
              <p className="form-error" role="alert">
                {decisionError}
              </p>
            )}
            <div className="roadmap-submit-dialog-actions">
              <button
                data-decision-cancel=""
                type="button"
                className="workspace-button workspace-button-outline"
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`workspace-button${decision.kind === 'reject' ? ' roadmap-reject-button' : ''}`}
                disabled={busy || (decision.kind === 'reject' && !reasonValid)}
              >
                {decision.kind === 'approve'
                  ? busy
                    ? 'Approving…'
                    : 'Approve and Publish'
                  : busy
                    ? 'Rejecting…'
                    : 'Reject Version'}
              </button>
            </div>
          </form>
        )}
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
                {!activeId && <option value="" disabled>Select a version</option>}
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
                  {sourcePlan?.status === 'converted' && sourcePlan.version_id === active.version_id && (
                    <span className="activity-plan-provenance">Imported from PDF</span>
                  )}
                  <h2 ref={versionHeadingRef} tabIndex={-1}>
                    {active.name}
                  </h2>
                  <p>{active.description || 'No description.'}</p>
                </div>
              </div>
              {canSubmit ? (
                <div
                  id="roadmap-review-feedback"
                  ref={feedbackRef}
                  tabIndex={-1}
                  role="region"
                  aria-label="Review feedback and history"
                >
                  <RoadmapReviewHistory
                    key={JSON.stringify([active.version_id, active.status, active.pending_submission?.id])}
                    organizationId={organizationId}
                    roadmapId={roadmapId}
                    versionId={active.version_id}
                    status={active.status}
                  >
                    {(reviewState) => <VersionMetadata version={active} reviewState={reviewState} />}
                  </RoadmapReviewHistory>
                </div>
              ) : (
                <VersionMetadata version={active} reviewState="Staff review history restricted" />
              )}
              {(blockedDecision ||
                (showDecisions && !submissionId && !recovery)) && (
                <div className="roadmap-decision-recovery">
                  <p role="alert">
                    {blockedDecision?.message ||
                      'Current review information is unavailable. Refresh the version before making a decision.'}
                  </p>
                  {reason.trim() && (
                    <details>
                      <summary>View unsent rejection feedback</summary>
                      <p className="roadmap-unsent-reason">{reason}</p>
                    </details>
                  )}
                  <button
                    type="button"
                    className="workspace-button workspace-button-outline"
                    disabled={busy}
                    onClick={refreshDecision}
                  >
                    Refresh review status
                  </button>
                </div>
              )}
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
                  {active.status === 'archived' && (
                    <p>
                      This version is archived. Assigned cohorts and their
                      progress remain available.
                    </p>
                  )}
                </>
              )}
              {active.status !== 'draft' && active.status !== 'in_review' && (
                <div
                  className="roadmap-editor-actions"
                  aria-label="Version actions"
                >
                  {canCopy && (
                    <button
                      type="button"
                      className="workspace-button workspace-button-outline"
                      disabled={busy || dirty || !!recovery}
                      onClick={copy}
                    >
                      Copy as new draft
                    </button>
                  )}
                  {active.status === 'published' && (
                    <>
                      <button
                        type="button"
                        className="workspace-button workspace-button-outline"
                        disabled={busy}
                        onClick={archive}
                      >
                        Archive version
                      </button>
                      <Link
                        className="workspace-button"
                        to={`/app/coordinator/learning?organizationId=${encodeURIComponent(organizationId)}&roadmapVersionId=${encodeURIComponent(active.version_id)}#cohort-setup`}
                      >
                        Assign to cohort
                      </Link>
                    </>
                  )}
                </div>
              )}
              {showDecisions && (
                <div
                  className="roadmap-editor-actions"
                  role="group"
                  aria-label="Review decision"
                >
                  <button
                    type="button"
                    className="workspace-button"
                    disabled={
                      busy || !submissionId || !!blockedDecision || !!recovery
                    }
                    onClick={(event) =>
                      openDecision('approve', event.currentTarget)
                    }
                  >
                    Approve and Publish
                  </button>
                  <button
                    type="button"
                    className="workspace-button workspace-button-outline roadmap-reject-trigger"
                    disabled={
                      busy || !submissionId || !!blockedDecision || !!recovery
                    }
                    onClick={(event) =>
                      openDecision('reject', event.currentTarget)
                    }
                  >
                    Reject
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  )
}
