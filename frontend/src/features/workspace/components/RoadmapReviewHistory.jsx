import { useCallback, useEffect, useRef, useState } from 'react'
import { listRoadmapReviews } from '../learningApi'

const pageSize = 20
const decisions = {
  pending: 'Awaiting review decision',
  approved: 'Approved and published',
  rejected: 'Rejected',
}
const emptyHistory = {
  snapshot: null,
  attempts: [],
  nextOffset: null,
  busy: true,
  error: null,
}
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function ReviewContext({ date, person }) {
  const timestamp = date && new Date(date)
  const validDate = timestamp && Number.isFinite(timestamp.getTime())
  const name = person?.display_name
  if (!validDate && !name) return null
  return (
    <span className="roadmap-review-context">
      {validDate && <time dateTime={date}>{dateFormat.format(timestamp)}</time>}
      {name && <span>By {name}</span>}
    </span>
  )
}

function ReviewAttempt({ attempt }) {
  const decision = decisions[attempt.decision]
  return (
    <li className="roadmap-review-attempt">
      <details>
        <summary>
          <span
            className={`roadmap-review-outcome roadmap-review-outcome--${attempt.decision}`}
          >
            {decision}
          </span>
          {Number.isInteger(attempt.submitted_revision) && (
            <span>Submitted revision {attempt.submitted_revision}</span>
          )}
          <ReviewContext
            date={
              attempt.decision === 'pending'
                ? attempt.submitted_at
                : attempt.reviewed_at
            }
            person={
              attempt.decision === 'pending'
                ? attempt.submitted_by
                : attempt.reviewed_by
            }
          />
        </summary>
        <div className="roadmap-review-attempt-detail">
          <p>
            <strong>Submitted for Review</strong>
            <ReviewContext
              date={attempt.submitted_at}
              person={attempt.submitted_by}
            />
          </p>
          {attempt.decision === 'rejected' && (
            <p className="roadmap-review-reason">
              {attempt.rejection_reason ||
                'No rejection feedback was provided.'}
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

function historyError(cause, offset) {
  const restricted = [401, 403].includes(cause?.status)
  const message =
    cause?.status === 401
      ? 'Sign in again to view review history.'
      : cause?.status === 403
        ? 'You do not have access to this review history.'
        : offset
          ? 'More review history could not be loaded. The loaded attempts are still available.'
          : 'Review history could not be loaded. Try again.'
  const reference = cause?.request_id
  return {
    restricted,
    offset,
    message:
      typeof reference === 'string' && /^[\w-]{1,80}$/.test(reference)
        ? `${message} Reference: ${reference}.`
        : message,
  }
}

function reviewSummary(status, history, completed, currentRejection) {
  if (history.error?.restricted) return 'History restricted'
  if (history.snapshot && history.snapshot.status !== status) {
    return 'Version status changed on server'
  }
  if (status === 'in_review') return 'Awaiting review decision'
  if (!history.snapshot) {
    return history.error ? 'History unavailable' : 'Loading review history…'
  }
  if (currentRejection) return 'Previously returned for revision'
  if (completed?.decision === 'approved') return 'Approved'
  return history.attempts.length
    ? 'Review history available'
    : 'No past review attempts'
}

export default function RoadmapReviewHistory({
  organizationId,
  roadmapId,
  versionId,
  status,
  children,
}) {
  const [history, setHistory] = useState(emptyHistory)
  const request = useRef(null)

  const load = useCallback(
    async (offset) => {
      // A refresh may supersede pagination. Ignore repeated clicks for a page
      // in flight and apply data only for the current request.
      if (request.current && (offset !== 0 || request.current.offset === 0))
        return
      const read = { offset }
      request.current = read
      setHistory((current) => ({ ...current, busy: true, error: null }))
      try {
        const result = await listRoadmapReviews(
          organizationId,
          roadmapId,
          versionId,
          {
            limit: pageSize,
            offset,
          },
        )
        if (request.current !== read) return
        if (
          result.version_id !== versionId ||
          !Array.isArray(result.reviews) ||
          result.reviews.some(
            (attempt) =>
              attempt.version_id !== versionId ||
              !attempt.id ||
              !Object.hasOwn(decisions, attempt.decision),
          ) ||
          result.pagination?.offset !== offset ||
          (result.pagination.next_offset !== null &&
            (!Number.isInteger(result.pagination.next_offset) ||
              result.pagination.next_offset <= offset))
        ) {
          throw new Error('Unexpected review history response')
        }
        setHistory((current) => {
          if (
            offset &&
            (current.snapshot?.revision !== result.revision ||
              current.snapshot?.status !== result.status)
          ) {
            return {
              ...current,
              busy: false,
              error: {
                offset: 0,
                message:
                  'Review history changed. Refresh it before loading more attempts.',
              },
            }
          }
          const entries = new Map(
            (offset ? current.attempts : []).map((attempt) => [
              attempt.id,
              attempt,
            ]),
          )
          for (const attempt of result.reviews) entries.set(attempt.id, attempt)
          return {
            snapshot: { revision: result.revision, status: result.status },
            attempts: [...entries.values()],
            nextOffset: result.pagination.next_offset,
            busy: false,
            error: null,
          }
        })
      } catch (cause) {
        if (request.current !== read) return
        const error = historyError(cause, offset)
        setHistory((current) => ({
          ...(error.restricted ? emptyHistory : current),
          busy: false,
          error,
        }))
      } finally {
        if (request.current === read) request.current = null
      }
    },
    [organizationId, roadmapId, versionId],
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load(0)
    })
    return () => {
      active = false
      request.current = null
    }
  }, [load])

  const completed = history.attempts.find(
    (attempt) => attempt.decision !== 'pending',
  )
  const currentRejection =
    status === 'draft' &&
    history.snapshot?.status === 'draft' &&
    completed?.decision === 'rejected'
      ? completed
      : null
  return (
    <>
      {children(reviewSummary(status, history, completed, currentRejection))}
      {currentRejection && (
        <section
          className="roadmap-returned-feedback"
          aria-labelledby="roadmap-returned-title"
        >
          <h3 id="roadmap-returned-title">Returned for revision</h3>
          <p>
            This roadmap version was returned for changes. Review the feedback
            before submitting it again.
          </p>
          <ReviewContext
            date={currentRejection.reviewed_at}
            person={currentRejection.reviewed_by}
          />
          <p className="roadmap-review-reason">
            <strong>Feedback </strong>
            {currentRejection.rejection_reason ||
              'No rejection feedback was provided.'}
          </p>
        </section>
      )}
      <details className="roadmap-review-history" open>
        <summary>
          <h3>Review history</h3>
        </summary>
        <div className="roadmap-review-history-body">
          {history.busy && <p role="status">Loading review history…</p>}
          {history.error && (
            <div className="roadmap-history-error">
              <p role="alert">{history.error.message}</p>
              {!history.error.restricted && (
                <button
                  type="button"
                  className="workspace-button workspace-button-outline"
                  onClick={() => load(history.error.offset)}
                >
                  {history.error.offset
                    ? 'Retry loading more history'
                    : 'Retry review history'}
                </button>
              )}
            </div>
          )}
          {history.snapshot &&
            !history.attempts.length &&
            !history.error &&
            !history.busy && <p>No review history yet</p>}
          {!!history.attempts.length && (
            <ol
              className="roadmap-review-timeline"
              aria-label="Review attempts, newest submitted revision first"
            >
              {history.attempts.map((attempt) => (
                <ReviewAttempt key={attempt.id} attempt={attempt} />
              ))}
            </ol>
          )}
          {history.snapshot && (!history.error || history.error.offset > 0) && (
            <div className="roadmap-history-actions">
              {history.nextOffset !== null && !history.error && (
                <button
                  type="button"
                  className="workspace-button workspace-button-outline"
                  disabled={history.busy}
                  onClick={() => load(history.nextOffset)}
                >
                  Load more history
                </button>
              )}
              <button
                type="button"
                className="workspace-button workspace-button-outline"
                onClick={() => load(0)}
              >
                Refresh history
              </button>
            </div>
          )}
        </div>
      </details>
    </>
  )
}
