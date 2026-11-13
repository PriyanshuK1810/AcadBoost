import { useEffect, useState } from 'react'
import { getMentorCohort, listMentorCohorts } from '../learningApi'
import { PageHeading } from './WorkspaceUI'

export default function MentorWorkspace(props) {
  return <MentorWorkspaceContent key={props.organizationId} {...props} />
}

function MentorWorkspaceContent({ organizationId, organizationName }) {
  const [list, setList] = useState({})
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState({})
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    listMentorCohorts(organizationId)
      .then((rows) => {
        if (active) setList({ organizationId, rows })
      })
      .catch((error) => {
        if (active) setList({ organizationId, error })
      })
    return () => {
      active = false
    }
  }, [organizationId, retry])
  const cohortId =
    selected?.organizationId === organizationId ? selected.id : null
  useEffect(() => {
    if (!cohortId) return
    let active = true
    getMentorCohort(organizationId, cohortId)
      .then((data) => {
        if (active) setDetail({ organizationId, cohortId, data })
      })
      .catch((error) => {
        if (active) setDetail({ organizationId, cohortId, error })
      })
    return () => {
      active = false
    }
  }, [organizationId, cohortId, retry])
  const currentList = list.organizationId === organizationId ? list : null
  const currentDetail =
    detail.organizationId === organizationId && detail.cohortId === cohortId
      ? detail
      : null
  const data = currentDetail?.data
  return (
    <>
      <PageHeading
        eyebrow="Workspace / Mentoring"
        title="Mentor workspace"
        description={organizationName}
      />
      {!currentList ? (
        <p role="status">Loading assigned cohorts…</p>
      ) : currentList.error ? (
        <div className="workspace-card">
          <p role="alert">
            Assigned cohorts could not be loaded. Your access may have changed.
          </p>
          <button
            type="button"
            onClick={() => {
              setList({})
              setRetry((n) => n + 1)
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <section className="workspace-card" aria-labelledby="assigned-cohorts">
          <h2 id="assigned-cohorts">Assigned cohorts</h2>
          {currentList.rows.length === 0 ? (
            <p>No cohorts are assigned to you.</p>
          ) : (
            <ul>
              {currentList.rows.map((cohort) => (
                <li key={cohort.id}>
                  <button
                    type="button"
                    className="workspace-button workspace-button-outline"
                    aria-pressed={cohortId === cohort.id}
                    onClick={() => {
                      setDetail({})
                    if (cohortId === cohort.id) setRetry((n) => n + 1)
                    else setSelected({ organizationId, id: cohort.id })
                    }}
                  >
                    {cohort.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {cohortId &&
        (!currentDetail ? (
          <p role="status">Loading cohort…</p>
        ) : currentDetail.error ? (
          <div className="workspace-card">
            <p role="alert">
              {[401, 403, 404].includes(currentDetail.error.status)
                ? 'This cohort is unavailable or your assignment has been revoked.'
                : 'This cohort could not be loaded. Try again.'}
            </p>
            <button
              type="button"
              className="workspace-button workspace-button-outline"
              onClick={() => {
                setDetail({})
                setRetry((n) => n + 1)
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <section
            className="workspace-card"
            aria-labelledby="mentor-cohort-title"
          >
            <h2 id="mentor-cohort-title">{data.cohort.name}</h2>
            <p>
              {data.cohort.roadmap_name} · Version{' '}
              {data.cohort.roadmap_version_number}
            </p>
            <h3>Cohort progress</h3>
            {data.progress.suppressed ? (
              <p>
                Progress is available when at least{' '}
                {data.progress.minimum_eligible_students} eligible students are
                in the cohort.
              </p>
            ) : (
              <p>
                {data.progress.percent}% complete ·{' '}
                {data.progress.completed_topic_assignments} of{' '}
                {data.progress.possible_topic_assignments} topic assignments ·{' '}
                {data.progress.eligible_students} eligible students
              </p>
            )}
            {data.progress.as_of && (
              <p>
                As of{' '}
                <time dateTime={data.progress.as_of}>
                  {new Date(data.progress.as_of).toLocaleString()}
                </time>
              </p>
            )}
            <h3>Pinned curriculum</h3>
            {data.phases.map((phase) => (
              <div key={phase.id}>
                <h4>{phase.title}</h4>
                {phase.weeks.map((week) => (
                  <div key={week.id}>
                    <h5>{week.title}</h5>
                    {data.deadlines
                      .filter((d) => d.week_id === week.id)
                      .map((d) => (
                        <p key={d.week_id}>
                          Deadline:{' '}
                          <time dateTime={d.due_at}>
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                              timeZone: d.time_zone,
                            }).format(new Date(d.due_at))}
                          </time>{' '}
                          ({d.time_zone})
                        </p>
                      ))}
                    <ul>
                      {week.topics.map((topic) => (
                        <li key={topic.id}>
                          <strong>{topic.title}</strong>
                          {topic.description && <p>{topic.description}</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
    </>
  )
}
