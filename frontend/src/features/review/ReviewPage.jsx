import { useEffect, useState } from 'react'
import BrandWordmark from '../../app/BrandWordmark'
import { PRODUCT_BRAND } from '../../app/brand'
import { restoreSession } from '../auth/authApi'
import {
  getReviewOverview,
  resetReviewProgress,
  updateReviewProgress,
} from './reviewApi'
import './ReviewPage.css'
const steps = [
  {
    number: '01',
    title: 'A college sets a shared path',
    description:
      'A coordinator can organize a roadmap around the skills students need to build.',
  },
  {
    number: '02',
    title: 'Students know what comes next',
    description:
      'Each learner sees the same clear plan and tracks their own topic completion.',
  },
  {
    number: '03',
    title: 'Progress becomes visible',
    description:
      'The cohort view shows how the group is moving through the plan and where support may help.',
  },
  {
    number: '04',
    title: 'The team improves the journey',
    description:
      'Coordinators use progress signals to refine future learning and placement support.',
  },
]
export default function ReviewPage({ view }) {
  const needsAccount = view === 'student' || view === 'coordinator'
  const [overview, setOverview] = useState(null)
  const [loading, setLoading] = useState(needsAccount)
  const [signedOut, setSignedOut] = useState(false)
  const [busyTopic, setBusyTopic] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!needsAccount) return
    let active = true
    void (async () => {
      try {
        const user = await restoreSession()
        if (!active) return
        if (!user) {
          setSignedOut(true)
          return
        }
        const data = await getReviewOverview()
        if (active) setOverview(data)
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load the review journey.',
          )
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [needsAccount])
  async function changeTopic(key, completed) {
    setBusyTopic(key)
    setError('')
    try {
      setOverview(await updateReviewProgress(key, completed))
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to save your progress.',
      )
    } finally {
      setBusyTopic(null)
    }
  }
  async function resetProgress() {
    setBusyTopic('reset')
    setError('')
    try {
      await resetReviewProgress()
      setOverview(await getReviewOverview())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to reset the scenario.',
      )
    } finally {
      setBusyTopic(null)
    }
  }
  const title = {
    walkthrough: `See how ${PRODUCT_BRAND} works`,
    student: 'Your learning journey',
    coordinator: 'A clearer view of the cohort',
    status: 'What is built today',
  }[view]
  return (
    <div className="review-page">
      <a className="skip-link" href="#review-main">
        Skip to content
      </a>
      <header className="review-header">
        <div className="page-container review-header-inner">
          <BrandWordmark className="wordmark" href="/" />
          <nav className="review-nav" aria-label="Review pages">
            <a
              aria-current={view === 'walkthrough' ? 'page' : undefined}
              href="/review"
            >
              How it works
            </a>
            <a
              aria-current={view === 'student' ? 'page' : undefined}
              href="/review/student"
            >
              Student
            </a>
            <a
              aria-current={view === 'coordinator' ? 'page' : undefined}
              href="/review/coordinator"
            >
              Coordinator
            </a>
            <a
              aria-current={view === 'status' ? 'page' : undefined}
              href="/review/status"
            >
              Build status
            </a>
          </nav>
        </div>
      </header>
      <main id="review-main" className="page-container review-main">
        <div className="review-heading">
          <p className="eyebrow">{PRODUCT_BRAND} review journey</p>
          <h1>{title}</h1>
          <p>
            {view === 'walkthrough'
              ? 'Follow one example from a learning plan to a clearer picture of student progress.'
              : view === 'student'
                ? 'Try a sample roadmap. Your changes are saved to your account and reflected in the coordinator preview.'
                : view === 'coordinator'
                  ? 'See how progress becomes useful for a college Training & Placement team.'
                  : 'A transparent view of the current implementation and the next product milestones.'}
          </p>
        </div>

        {view === 'walkthrough' && (
          <>
            <div className="review-notice">
              <strong>Review scenario</strong>
              <span>
                The roadmap and cohort members below are illustrative. Your own
                topic interactions are saved through the backend.
              </span>
            </div>
            <div className="walkthrough-grid">
              {steps.map((step) => (
                <article className="walkthrough-card" key={step.number}>
                  <span>{step.number}</span>
                  <h2>{step.title}</h2>
                  <p>{step.description}</p>
                </article>
              ))}
            </div>
            <div className="review-actions">
              <a className="button button-primary" href="/review/student">
                Open the student view <span aria-hidden="true">→</span>
              </a>
              <a className="review-text-link" href="/review/coordinator">
                See the coordinator view <span aria-hidden="true">↗</span>
              </a>
            </div>
          </>
        )}

        {view === 'status' && <StatusContent />}

        {needsAccount && loading && (
          <div className="review-state" role="status">
            Loading your review journey…
          </div>
        )}
        {needsAccount && signedOut && !loading && (
          <div className="review-state">
            <h2>Sign in to try the interactive journey</h2>
            <p>
              Your progress is stored under your account so the student and
              coordinator views stay in sync.
            </p>
            <a className="button button-primary" href="/login">
              Sign in <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {overview && view === 'student' && (
          <StudentContent
            overview={overview}
            busyTopic={busyTopic}
            onChange={changeTopic}
            onReset={resetProgress}
          />
        )}
        {overview?.coordinator && view === 'coordinator' && (
          <CoordinatorContent overview={overview} />
        )}
      </main>
      <footer className="review-footer">
        <div className="page-container">
          <span>{PRODUCT_BRAND} review scenario</span>
          <a href="/">Back to homepage ↑</a>
        </div>
      </footer>
    </div>
  )
}
function StudentContent({ overview, busyTopic, onChange, onReset }) {
  const { student } = overview
  return (
    <>
      <div className="review-notice">
        <strong>Illustrative roadmap</strong>
        <span>
          This sample plan demonstrates the experience. Only your completion
          choices are saved.
        </span>
      </div>
      <section className="review-summary" aria-label="Your progress summary">
        <div>
          <p className="eyebrow">Career readiness foundations</p>
          <h2>
            {student.completed} of {student.total} topics complete
          </h2>
          <p>
            {student.next_topic
              ? `Next: ${student.next_topic.title}`
              : 'You have completed the sample roadmap.'}
          </p>
        </div>
        <div className="review-progress">
          <strong>{student.percent}%</strong>
          <progress max={student.total} value={student.completed}>
            {student.percent}%
          </progress>
        </div>
      </section>
      <div className="review-section-header">
        <h2>Roadmap</h2>
        <button
          type="button"
          className="review-reset"
          onClick={onReset}
          disabled={busyTopic !== null}
        >
          Reset my demo progress
        </button>
      </div>
      <div className="review-phase-list">
        {student.phases.map((phase, index) => (
          <section className="review-phase" key={phase.title}>
            <div className="review-phase-heading">
              <span>Phase {String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{phase.title}</h3>
                <p>{phase.description}</p>
              </div>
            </div>
            <div className="review-topic-list">
              {phase.topics.map((topic) => (
                <article
                  className="review-topic"
                  key={topic.key}
                  id={`topic-${topic.key}`}
                >
                  <div
                    className={`review-topic-indicator${topic.status === 'completed' ? ' is-complete' : ''}`}
                    aria-hidden="true"
                  >
                    {topic.status === 'completed' ? '✓' : topic.week}
                  </div>
                  <div className="review-topic-copy">
                    <p className="review-topic-week">Week {topic.week}</p>
                    <h4>{topic.title}</h4>
                    <p>{topic.description}</p>
                  </div>
                  <button
                    type="button"
                    className="review-topic-button"
                    disabled={busyTopic !== null}
                    aria-pressed={topic.status === 'completed'}
                    onClick={() =>
                      onChange(topic.key, topic.status !== 'completed')
                    }
                  >
                    {busyTopic === topic.key
                      ? 'Saving…'
                      : topic.status === 'completed'
                        ? 'Completed'
                        : 'Mark complete'}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="review-next">
        <p>Your completion changes also appear in the coordinator preview.</p>
        <a className="button button-primary" href="/review/coordinator">
          View cohort progress →
        </a>
      </div>
    </>
  )
}
function CoordinatorContent({ overview }) {
  const coordinator = overview.coordinator
  return (
    <>
      <div className="review-notice">
        <strong>Illustrative cohort</strong>
        <span>
          Peer names and progress are sample data. The “You” row reflects your
          saved topic completion.
        </span>
      </div>
      <section className="cohort-overview" aria-label="Cohort summary">
        <div>
          <p className="eyebrow">Example cohort</p>
          <h2>{coordinator.cohort_title}</h2>
          <p>Assigned roadmap: {coordinator.roadmap_title}</p>
        </div>
        <div className="cohort-metrics">
          <div>
            <strong>{coordinator.members.length}</strong>
            <span>Learners</span>
          </div>
          <div>
            <strong>{coordinator.average_percent}%</strong>
            <span>Average completion</span>
          </div>
        </div>
      </section>
      <div className="coordinator-grid">
        <section className="review-panel" aria-labelledby="learners-title">
          <h2 id="learners-title">Learner progress</h2>
          <p className="review-panel-intro">
            See who is moving through the plan and who may need support.
          </p>
          <div className="learner-list">
            {coordinator.members.map((member) => (
              <div
                className="learner-row"
                key={member.is_you ? 'you' : member.name}
              >
                <div className="learner-row-top">
                  <strong>
                    {member.is_you ? `${member.name} (You)` : member.name}
                  </strong>
                  <span>
                    {member.completed}/{member.total} topics · {member.percent}%
                  </span>
                </div>
                <progress max={member.total} value={member.completed}>
                  {member.percent}%
                </progress>
              </div>
            ))}
          </div>
        </section>
        <section className="review-panel" aria-labelledby="topics-title">
          <h2 id="topics-title">Topic completion</h2>
          <p className="review-panel-intro">
            A quick signal for where this example cohort is progressing.
          </p>
          <div className="stat-list">
            {coordinator.topics.map((topic) => (
              <div className="stat-row" key={topic.title}>
                <span>{topic.title}</span>
                <strong>
                  {topic.completed}/{topic.total}
                </strong>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="review-next">
        <p>
          Mark a topic complete in the student view to see this summary change.
        </p>
        <a className="button button-primary" href="/review/student">
          Try the student view →
        </a>
      </div>
    </>
  )
}
function StatusContent() {
  return (
    <>
      <div className="status-grid">
        <section className="review-panel">
          <span className="status-tag is-built">Working now</span>
          <h2>Authentication</h2>
          <p>
            Password registration, sign in, session restoration, and logout use
            the live backend. The review scenario saves each signed-in user’s
            topic completion in PostgreSQL.
          </p>
        </section>
        <section className="review-panel">
          <span className="status-tag is-demo">Review scenario</span>
          <h2>Student and coordinator views</h2>
          <p>
            The example roadmap, cohort and peer learners help demonstrate the
            product loop. The student’s topic changes are real, but the example
            cohort is not a production organization.
          </p>
        </section>
        <section className="review-panel">
          <span className="status-tag is-next">Planned core platform</span>
          <h2>Tenant and roadmap management</h2>
          <p>
            Organization membership, published roadmap versions, cohort
            enrollment, full progress tracking, imports, and analytics remain on
            the product roadmap.
          </p>
        </section>
      </div>
      <div className="review-next">
        <p>
          Start with the guided journey, then try both sides of the example.
        </p>
        <a className="button button-primary" href="/review">
          Explore how it works →
        </a>
      </div>
    </>
  )
}
