import { useEffect, useId, useState } from 'react'
import {
  assignMentor,
  listMentorAssignments,
  revokeMentorAssignment,
} from '../learningApi'

export default function MentorAssignments(props) {
  return <MentorAssignmentsContent key={props.organizationId} {...props} />
}

function MentorAssignmentsContent({ organizationId }) {
  const mentorInputId = useId()
  const cohortInputId = useId()
  const [state, setState] = useState({})
  const [mentor, setMentor] = useState('')
  const [cohort, setCohort] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    listMentorAssignments(organizationId)
      .then((data) => {
        if (active) setState({ organizationId, data })
      })
      .catch((error) => {
        if (active) setState({ organizationId, error })
      })
    return () => {
      active = false
    }
  }, [organizationId, retry])
  const current = state.organizationId === organizationId ? state : null
  async function change(action, row) {
    if (busy) return
    setBusy(true)
    try {
      if (action === 'assign') {
        const result = await assignMentor(organizationId, cohort, mentor)
        setState((previous) =>
          previous.organizationId === organizationId
            ? {
                ...previous,
                data: {
                  ...previous.data,
                  assignments: [
                    ...previous.data.assignments.filter(
                      (a) =>
                        !(
                          a.cohort_id === result.cohort_id &&
                          a.membership_id === result.membership_id
                        ),
                    ),
                    result,
                  ],
                },
              }
            : previous,
        )
      } else {
        await revokeMentorAssignment(
          organizationId,
          row.cohort_id,
          row.membership_id,
        )
        setState((previous) =>
          previous.organizationId === organizationId
            ? {
                ...previous,
                data: {
                  ...previous.data,
                  assignments: previous.data.assignments.filter(
                    (a) => a.id !== row.id,
                  ),
                },
              }
            : previous,
        )
      }
    } catch {
      setState((previous) =>
        previous.organizationId === organizationId
          ? {
              ...previous,
              error: new Error(
                'Unable to update assignments. Reload and try again.',
              ),
            }
          : previous,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="workspace-card"
      aria-labelledby="mentor-assignments-heading"
    >
      <h2 id="mentor-assignments-heading">Mentor assignments</h2>
      {!current ? (
        <p role="status">Loading mentor assignments…</p>
      ) : current.error ? (
        <>
          <p role="alert">Mentor assignments could not be loaded or updated.</p>
          <button
            type="button"
            className="workspace-button workspace-button-outline"
            onClick={() => {
              setState({})
              setRetry((n) => n + 1)
            }}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <form
            className="learning-inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (mentor && cohort) void change('assign')
            }}
          >
            <div className="form-field">
              <label htmlFor={mentorInputId}>Mentor</label>
              <select
                id={mentorInputId}
                value={mentor}
                onChange={(event) => setMentor(event.target.value)}
              >
                <option value="">Select mentor</option>
                {current.data.mentors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={cohortInputId}>Cohort</label>
              <select
                id={cohortInputId}
                value={cohort}
                onChange={(event) => setCohort(event.target.value)}
              >
                <option value="">Select cohort</option>
                {current.data.cohorts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="workspace-button"
              disabled={busy || !mentor || !cohort}
            >
              Assign mentor
            </button>
          </form>
          {current.data.assignments.length === 0 ? (
            <p>No mentor assignments.</p>
          ) : (
            <ul>
              {current.data.assignments.map((row) => {
                const mentorName =
                  current.data.mentors.find(
                    (item) => item.id === row.membership_id,
                  )?.display_name ??
                  row.mentor_name ??
                  'Unavailable mentor'
                const cohortName =
                  current.data.cohorts.find((item) => item.id === row.cohort_id)
                    ?.name ?? 'Unavailable cohort'
                return (
                  <li key={row.id}>
                    <span>
                      {mentorName} — {cohortName}
                    </span>{' '}
                    <button
                      type="button"
                      className="workspace-button workspace-button-outline"
                      disabled={busy}
                      aria-label={`Remove ${mentorName} from ${cohortName}`}
                      onClick={() => void change('remove', row)}
                    >
                      Remove
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
