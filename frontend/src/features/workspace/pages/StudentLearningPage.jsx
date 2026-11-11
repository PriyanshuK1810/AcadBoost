import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import LiveResourceState from '../components/LiveResourceState'
import { EmptyState, PageHeading, ProgressBar } from '../components/WorkspaceUI'
import { useLiveResource } from '../hooks/useLiveResource'
import {
  getMyLearning,
  joinCohort,
  setTopicProgress,
  withdrawFromCohort,
} from '../learningApi'

function joinFailure(status) {
  if (status === 404)
    return 'This join code is invalid, expired, or revoked. Ask your coordinator for a current code.'
  if (status === 403)
    return 'Your account does not have permission to join this cohort.'
  if (status === 409)
    return 'Your enrollment requires staff reinstatement. Contact your coordinator.'
  if (status === 429)
    return 'Too many attempts. Wait before trying another code.'
  if (status === 400 || status === 422)
    return 'Check the join code and try again.'
  return 'We couldn’t confirm enrollment. Refresh your cohorts before submitting another code.'
}

export default function StudentLearningPage({ roadmapOnly = false }) {
  const resource = useLiveResource(getMyLearning)
  const [search, setSearch] = useSearchParams()
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [joinedId, setJoinedId] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const pending = useRef(false)
  const feedbackRef = useRef(null)
  const learning = resource.data ?? []
  const requested = search.get('cohortId')
  const selected =
    requested ?? (roadmapOnly ? learning[0]?.cohort_id : '') ?? ''
  const visible = selected
    ? learning.filter((item) => item.cohort_id === selected)
    : learning
  const locked = Boolean(
    busy || resource.loading || resource.error || needsRefresh,
  )
  const joined = learning.find((item) => item.cohort_id === joinedId)

  useEffect(() => {
    if (error || message) feedbackRef.current?.focus()
  }, [error, message])

  function refresh() {
    setNeedsRefresh(false)
    setError('')
    resource.retry()
  }

  async function mutate(key, action, failure) {
    if (pending.current || locked) return
    pending.current = true
    setBusy(key)
    setError('')
    setMessage('')
    setJoinedId('')
    try {
      const result = await action()
      setMessage(result.message)
      if (result.cohortId) setJoinedId(result.cohortId)
      resource.retry()
    } catch (cause) {
      const status = cause?.status
      setError(failure(status))
      if (!status || status >= 500) setNeedsRefresh(true)
      else if (key !== 'join' && [401, 403, 404].includes(status))
        resource.retry()
    } finally {
      pending.current = false
      setBusy('')
    }
  }

  function submitJoin(event) {
    event.preventDefault()
    const code = inviteCode.trim()
    if (locked || pending.current) return
    if (code.length < 20 || code.length > 64) {
      setError(
        code
          ? 'Check the join code and try again.'
          : 'Enter your cohort’s join code.',
      )
      return
    }
    const existingIds = new Set(learning.map((item) => item.cohort_id))
    void mutate(
      'join',
      async () => {
        const result = await joinCohort(code)
        setInviteCode('')
        return {
          cohortId: result.cohort_id,
          message: existingIds.has(result.cohort_id)
            ? 'You are already enrolled in ' + result.cohort_name + '.'
            : 'You joined ' + result.cohort_name + '.',
        }
      },
      joinFailure,
    )
  }

  function changeTopic(topic) {
    void mutate(
      topic.id,
      async () => {
        await setTopicProgress(topic.id, !topic.completed)
        return {
          message: topic.completed
            ? 'Topic reopened.'
            : 'Topic marked complete.',
        }
      },
      () =>
        'We couldn’t confirm the progress update. Refresh your learning to check the saved state.',
    )
  }

  function leaveCohort(assignment) {
    void mutate(
      'leave:' + assignment.cohort_id,
      async () => {
        await withdrawFromCohort(assignment.cohort_id)
        return {
          message:
            'You left ' +
            assignment.cohort_name +
            '. Your saved progress is retained.',
        }
      },
      () =>
        'We couldn’t confirm that you left the cohort. Refresh your cohorts to check your enrollment.',
    )
  }

  return (
    <div className="student-learning">
      <PageHeading
        eyebrow={
          roadmapOnly ? 'Student / Assigned roadmap' : 'Student / My cohorts'
        }
        title={roadmapOnly ? 'Your assigned roadmap' : 'Your assigned learning'}
        description={
          roadmapOnly
            ? 'Read the curriculum assigned to your cohort and update your own progress.'
            : 'Join a cohort and see your assigned learning and progress.'
        }
        action={
          roadmapOnly && (
            <Link
              className="workspace-button workspace-button-outline"
              to="/app/student/learning"
            >
              Manage cohorts
            </Link>
          )
        }
      />
      {error && (
        <p className="form-error" role="alert" tabIndex={-1} ref={feedbackRef}>
          {error}
        </p>
      )}
      {needsRefresh && (
        <button
          className="workspace-button workspace-button-outline"
          type="button"
          onClick={refresh}
        >
          Refresh your learning
        </button>
      )}
      {message && (
        <p
          className="form-message"
          role="status"
          tabIndex={-1}
          ref={feedbackRef}
        >
          {message}{' '}
          {joined && (
            <Link
              className="workspace-text-link"
              to={
                '/app/student/roadmap?cohortId=' +
                encodeURIComponent(joined.cohort_id)
              }
            >
              Open assigned learning
            </Link>
          )}
        </p>
      )}
      {!roadmapOnly && (
        <section id="join-cohort" className="workspace-card learning-join">
          <h2>Join a cohort</h2>
          <p>Enter the join code provided by your coordinator.</p>
          <form
            className="learning-inline-form"
            onSubmit={submitJoin}
            noValidate
          >
            <label className="form-field">
              <span>Join code</span>
              <input
                required
                maxLength={64}
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                readOnly={Boolean(busy)}
              />
            </label>
            <button className="workspace-button" disabled={locked}>
              {busy === 'join' ? 'Joining…' : 'Join cohort'}
            </button>
          </form>
        </section>
      )}
      <LiveResourceState {...resource} />
      {!!learning.length && (
        <label className="form-field student-cohort-picker">
          <span>Cohort</span>
          <select
            value={selected}
            onChange={(event) => {
              const next = new URLSearchParams(search)
              if (event.target.value) next.set('cohortId', event.target.value)
              else next.delete('cohortId')
              setSearch(next)
            }}
          >
            {!roadmapOnly && <option value="">All cohorts</option>}
            {requested && !visible.length && (
              <option value={requested}>Unavailable cohort</option>
            )}
            {learning.map((item) => (
              <option key={item.cohort_id} value={item.cohort_id}>
                {item.cohort_name} · {item.organization_name}
              </option>
            ))}
          </select>
        </label>
      )}
      {resource.data && !visible.length && (
        <EmptyState
          title={
            selected ? 'This cohort is unavailable' : 'No assigned roadmap yet'
          }
          description={
            selected
              ? 'Choose another cohort or return to your cohort list.'
              : 'Join a cohort to open its assigned roadmap.'
          }
          actionTo={roadmapOnly ? '/app/student/learning' : undefined}
          actionLabel={roadmapOnly ? 'Open my cohorts' : undefined}
        />
      )}
      <div className="learning-assignments">
        {visible.map((assignment) => (
          <section
            className="workspace-card learning-assignment"
            key={assignment.cohort_id}
          >
            <div className="learning-assignment-header">
              <div>
                <p className="workspace-eyebrow">
                  {assignment.organization_name} / {assignment.cohort_name}
                </p>
                <h2>{assignment.roadmap_name}</h2>
                <p>Assigned version {assignment.roadmap_version_number}</p>
                <p>
                  {assignment.completed} of {assignment.total} topics completed
                </p>
              </div>
              <strong>{assignment.percent}%</strong>
            </div>
            <ProgressBar
              value={assignment.percent}
              label={assignment.cohort_name + ' completion'}
            />
            {!roadmapOnly && (
              <div className="learning-assignment-actions">
                <Link
                  className="workspace-text-link"
                  to={
                    '/app/student/roadmap?cohortId=' +
                    encodeURIComponent(assignment.cohort_id)
                  }
                >
                  Open assigned roadmap
                </Link>
                <button
                  type="button"
                  className="workspace-button workspace-button-outline"
                  disabled={locked}
                  onClick={() => leaveCohort(assignment)}
                >
                  {busy === 'leave:' + assignment.cohort_id
                    ? 'Leaving…'
                    : 'Leave cohort'}
                </button>
                <small>
                  Your completed topics remain saved if you join again.
                </small>
              </div>
            )}
            {(
              assignment.phases || [
                {
                  id: 'flat',
                  title: '',
                  weeks: [{ id: 'flat', title: '', topics: assignment.topics }],
                },
              ]
            ).map((phase) => (
              <details
                className="learning-phase student-phase"
                key={phase.id}
                open
              >
                <summary>{phase.title || 'Topics'}</summary>
                {phase.weeks.map((week) => (
                  <section className="learning-week" key={week.id}>
                    {week.title && <h3>{week.title}</h3>}
                    <div className="learning-topic-list">
                      {week.topics.map((topic) => (
                        <div className="learning-topic" key={topic.id}>
                          <div>
                            <h4>{topic.title}</h4>
                            {topic.description && <p>{topic.description}</p>}
                          </div>
                          <button
                            type="button"
                            className={
                              topic.completed
                                ? 'learning-topic-done'
                                : 'workspace-button'
                            }
                            disabled={locked}
                            onClick={() => changeTopic(topic)}
                            aria-pressed={topic.completed}
                            aria-description={
                              topic.completed
                                ? 'Activate to reopen this topic'
                                : undefined
                            }
                          >
                            {busy === topic.id
                              ? 'Saving…'
                              : topic.completed
                                ? 'Completed ✓'
                                : 'Mark complete'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </details>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
