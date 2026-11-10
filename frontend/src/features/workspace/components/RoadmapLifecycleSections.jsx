import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import RoadmapStatusBadge from './RoadmapStatusBadge'
import { listRoadmapReviews } from '../learningApi'

const historyConcurrency = 3
const feedbackAnchor = '#roadmap-review-feedback'
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function useDraftHistory(organizationId, versions) {
  const [results, setResults] = useState({})
  const [retry, setRetry] = useState(null)
  useEffect(() => {
    let active = true
    const drafts = versions.filter(
      (row) => row.status === 'draft' && row.version_id,
    )
    const queue = retry ?? drafts
    let next = 0

    async function readNext() {
      while (active && next < queue.length) {
        const row = queue[next++]
        let outcome = { unavailable: true }
        try {
          const history = await listRoadmapReviews(
            organizationId,
            row.id,
            row.version_id,
            { limit: 1, offset: 0 },
          )
          const latest = history.reviews?.[0]
          // A valid Draft snapshot has no pending review. Its first attempt,
          // if present, is the most recent completed attempt in server order.
          if (
            history.version_id === row.version_id &&
            history.status === 'draft' &&
            Array.isArray(history.reviews) &&
            (history.reviews.length === 0 ||
              (latest?.version_id === row.version_id &&
                ['approved', 'rejected'].includes(latest.decision)))
          ) {
            outcome = {
              rejection: latest?.decision === 'rejected' ? latest : null,
            }
          }
        } catch {
          // An unavailable read leaves the Draft unclassified.
        }
        if (active)
          setResults((current) => ({ ...current, [row.version_id]: outcome }))
      }
    }

    queueMicrotask(() => {
      for (
        let worker = 0;
        worker < Math.min(queue.length, historyConcurrency);
        worker++
      ) {
        void readNext()
      }
    })
    return () => {
      active = false
    }
  }, [organizationId, versions, retry])

  function retryUnavailable() {
    const failed = versions.filter(
      (row) => results[row.version_id]?.unavailable,
    )
    if (!failed.length) return
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, result]) => !result.unavailable),
      ),
    )
    setRetry(failed)
  }

  return { results, retryUnavailable }
}

function validTime(value) {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function pendingInfo(row) {
  const pending = row.pending_submission
  return pending?.version_id === row.version_id &&
    pending.decision === 'pending'
    ? pending
    : null
}

function newestSubmissionFirst(a, b) {
  const aTime = validTime(pendingInfo(a)?.submitted_at)
  const bTime = validTime(pendingInfo(b)?.submitted_at)
  return (bTime ?? -Infinity) - (aTime ?? -Infinity) || 0
}

function Section({ title, tone, count, children }) {
  return (
    <details
      className={'roadmap-lifecycle-section roadmap-lifecycle-' + tone}
      open
    >
      <summary>
        <h2>{title}</h2>
        <span className="roadmap-lifecycle-count">{count}</span>
      </summary>
      <div className="roadmap-lifecycle-body">{children}</div>
    </details>
  )
}

function VersionCard({
  row,
  organizationId,
  action,
  subgroup = false,
  rejection,
  children,
}) {
  const Heading = subgroup ? 'h4' : 'h3'
  const query = new URLSearchParams({ organizationId })
  if (row.version_id) query.set('versionId', row.version_id)
  const actionLabel = row.version_id ? action : 'View Versions'
  const version = Number.isInteger(row.version_number)
    ? 'v' + row.version_number
    : ''
  const path =
    '/app/coordinator/roadmaps/' +
    encodeURIComponent(row.id) +
    '/versions?' +
    query
  return (
    <article className="workspace-card roadmap-discovery-row">
      <div className="roadmap-discovery-title">
        <Heading>{row.name}</Heading>
        {row.description && <p>{row.description}</p>}
      </div>
      <div className="roadmap-discovery-lifecycle">
        <p className="roadmap-discovery-version">
          {version && <strong>Version {version}</strong>}
          {row.status && <RoadmapStatusBadge status={row.status} />}
        </p>
        {Number.isInteger(row.revision) && <p>Revision {row.revision}</p>}
        {children}
      </div>
      <Link
        className={
          'workspace-button' +
          (actionLabel === 'Review Version' ? '' : ' workspace-button-outline')
        }
        to={path + (rejection ? feedbackAnchor : '')}
        aria-label={[actionLabel + ' for ' + row.name, row.version_id && version]
          .filter(Boolean)
          .join(' ')}
      >
        {actionLabel}
      </Link>
    </article>
  )
}

function ReviewDate({ date, label }) {
  const time = validTime(date)
  if (time === null) return null
  return (
    <p>
      {label} <time dateTime={date}>{dateFormat.format(time)}</time>
    </p>
  )
}

function previewReason(reason) {
  const characters = Array.from(reason?.trim() || '')
  return characters.length > 180
    ? characters.slice(0, 180).join('') + '…'
    : characters.join('')
}

function countLabel(count, singular) {
  return count + ' ' + singular + (count === 1 ? '' : 's')
}

export default function RoadmapLifecycleSections({
  organizationId,
  role,
  versions,
  visibleRoadmaps,
  statusFilter,
  isSearching,
  createdDrafts,
}) {
  const { results, retryUnavailable } = useDraftHistory(
    organizationId,
    versions,
  )
  const pending = visibleRoadmaps
    .flatMap(({ rows }) => rows.filter((row) => row.status === 'in_review'))
    .sort(newestSubmissionFirst)
  const activeRoadmaps = visibleRoadmaps.filter(
    ({ latest }) => !statusFilter || latest?.status === statusFilter,
  )
  const published = activeRoadmaps.flatMap(({ rows }) =>
    rows.filter((row) => row.status === 'published'),
  )
  const matchingDrafts = visibleRoadmaps.flatMap(({ rows }) =>
    rows.filter((row) => row.status === 'draft'),
  )
  const returned = matchingDrafts.filter(
    (row) => results[row.version_id]?.rejection,
  )
  const awaitingHistory = (row) =>
    row.version_id &&
    !createdDrafts.has(row.version_id) &&
    !results[row.version_id]
  const historyUnavailable = (row) =>
    !row.version_id || results[row.version_id]?.unavailable
  const classificationPending = matchingDrafts.some(awaitingHistory)
  const unavailable = matchingDrafts.filter(historyUnavailable)
  const activeDrafts = activeRoadmaps.flatMap(({ rows }) =>
    rows.filter((row) => row.status === 'draft'),
  )
  const drafts = activeDrafts.filter(
    (row) =>
      createdDrafts.has(row.version_id) ||
      results[row.version_id]?.rejection === null,
  )
  const activeUnavailable = activeDrafts.filter(historyUnavailable)
  const activeLoading = activeDrafts.some(awaitingHistory)
  const other = activeRoadmaps.filter(({ rows }) =>
    rows.every(
      (row) => !['in_review', 'draft', 'published'].includes(row.status),
    ),
  )
  const publishedCount = new Set(published.map((row) => row.id)).size
  const activeCount = new Set([...published, ...drafts].map((row) => row.id))
    .size
  const canReview = role === 'owner' || role === 'admin'
  const anyReadsPending = versions.some(
    (row) =>
      row.status === 'draft' && row.version_id && !results[row.version_id],
  )

  return (
    <>
      <Section
        title="Pending Review"
        tone="pending"
        count={countLabel(pending.length, 'version')}
      >
        <p>Submitted versions awaiting an Owner or Admin decision.</p>
        {!pending.length && (
          <p>
            {isSearching
              ? 'No versions awaiting review match this search.'
              : 'No versions awaiting review.'}
          </p>
        )}
        {pending.map((row) => {
          const submission = pendingInfo(row)
          return (
            <VersionCard
              key={row.version_id}
              row={row}
              organizationId={organizationId}
              action={canReview ? 'Review Version' : 'View Version'}
            >
              <ReviewDate date={submission?.submitted_at} label="Submitted" />
              {submission?.submitted_by?.display_name && (
                <p>By {submission.submitted_by.display_name}</p>
              )}
            </VersionCard>
          )
        })}
      </Section>

      <Section
        title="Active Roadmaps"
        tone="active"
        count={countLabel(activeCount, 'confirmed roadmap')}
      >
        <p>
          Published content stays available while newer versions are developed.
        </p>
        {published.length > 0 && (
          <div className="roadmap-lifecycle-group">
            <h3>
              Available to learners{' '}
              <span>{countLabel(publishedCount, 'roadmap')}</span>
            </h3>
            {published.map((row) => (
              <VersionCard
                key={row.version_id}
                row={row}
                organizationId={organizationId}
                action="View Versions"
                subgroup
              />
            ))}
          </div>
        )}
        {drafts.length > 0 && (
          <div className="roadmap-lifecycle-group">
            <h3>
              Drafts in progress{' '}
              <span>{countLabel(drafts.length, 'version')}</span>
            </h3>
            {drafts.map((row) => (
              <VersionCard
                key={row.version_id}
                row={row}
                organizationId={organizationId}
                action="Continue Editing"
                subgroup
              />
            ))}
          </div>
        )}
        {!activeCount && !activeLoading && !activeUnavailable.length && (
          <p>No active roadmaps or drafts found.</p>
        )}
        {activeLoading && (
          <p>Drafts are being checked for returned feedback.</p>
        )}
        {activeUnavailable.length > 0 && (
          <div className="roadmap-lifecycle-group">
            <h3>Drafts with unavailable history</h3>
            {activeUnavailable.map((row) => (
              <VersionCard
                key={row.version_id || row.id}
                row={row}
                organizationId={organizationId}
                action="Continue Editing"
                subgroup
              />
            ))}
          </div>
        )}
        {other.length > 0 && (
          <div className="roadmap-lifecycle-group">
            <h3>Other roadmap versions</h3>
            {other.map(({ details }) => (
              <VersionCard
                key={details.id}
                row={details}
                organizationId={organizationId}
                action="View Versions"
                subgroup
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Expired & Returned"
        tone="returned"
        count={
          classificationPending
            ? 'Checking drafts…'
            : unavailable.length
              ? 'Partial results'
              : countLabel(returned.length, 'returned version')
        }
      >
        <p>
          Showing versions returned for revision. Approval-expiration tracking
          is not configured.
        </p>
        {classificationPending && (
          <p role="status">Checking draft review histories…</p>
        )}
        {unavailable.length > 0 && (
          <div className="roadmap-lifecycle-retry">
            <p role="alert">
              Some draft review histories could not be checked. The results are
              incomplete.
            </p>
            {unavailable.some(
              (row) => results[row.version_id]?.unavailable,
            ) && (
              <button
                type="button"
                className="workspace-button workspace-button-outline"
                disabled={anyReadsPending}
                onClick={retryUnavailable}
              >
                Retry history checks
              </button>
            )}
          </div>
        )}
        {!classificationPending && !unavailable.length && !returned.length && (
          <p>
            {isSearching
              ? 'No returned versions match this search.'
              : 'No versions currently identified as returned for revision.'}
          </p>
        )}
        {returned.map((row) => {
          const rejection = results[row.version_id].rejection
          const preview = previewReason(rejection.rejection_reason)
          return (
            <VersionCard
              key={row.version_id}
              row={row}
              organizationId={organizationId}
              action="View Feedback"
              rejection={rejection}
            >
              <p className="roadmap-lifecycle-returned-label">
                Returned for revision
              </p>
              <ReviewDate date={rejection.reviewed_at} label="Returned" />
              {preview && <p>{preview}</p>}
            </VersionCard>
          )
        })}
      </Section>
    </>
  )
}
