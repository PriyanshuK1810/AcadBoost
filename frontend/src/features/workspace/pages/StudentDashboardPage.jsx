import { Link } from 'react-router'
import { useWorkspace } from '../hooks/useWorkspace'
import { useLiveResource } from '../hooks/useLiveResource'
import { getMyLearning } from '../learningApi'
import LiveResourceState from '../components/LiveResourceState'
import {
  EmptyState,
  MetricCard,
  PageHeading,
  ProgressBar,
} from '../components/WorkspaceUI'
export default function StudentDashboardPage() {
  const { user } = useWorkspace()
  const resource = useLiveResource(getMyLearning)
  const learning = resource.data || []
  const topics = new Map(
    learning.flatMap((item) => item.topics).map((topic) => [topic.id, topic]),
  )
  const completed = [...topics.values()].filter(
    (topic) => topic.completed,
  ).length
  const next = [...topics.values()].find((topic) => !topic.completed)
  const nextAssignment = next
    ? learning.find((item) => item.topics.some((topic) => topic.id === next.id))
    : learning[0]
  const roadmapUrl = (item) =>
    '/app/student/roadmap?cohortId=' + encodeURIComponent(item.cohort_id)
  return (
    <div className="student-overview">
      <PageHeading
        eyebrow="Student / Overview"
        title={'Good to see you, ' + user.display_name.split(' ')[0] + '.'}
        description="Your enrolled cohorts and personal progress on their exact assigned roadmap versions."
        action={
          <Link className="workspace-button" to="/app/student/learning">
            Join a cohort →
          </Link>
        }
      />
      <LiveResourceState {...resource} />
      {resource.data && (
        <>
          {!!learning.length && (
            <section
              className="student-cohort-section"
              aria-labelledby="student-cohort-title"
            >
              <h2 id="student-cohort-title">My cohorts</h2>
              <div className="learning-assignments student-cohort-cards">
                {learning.map((item) => (
                  <article className="workspace-card" key={item.cohort_id}>
                    <p className="workspace-eyebrow">
                      {item.organization_name} / {item.cohort_name}
                    </p>
                    <h3>{item.roadmap_name}</h3>
                    <p>
                      Version {item.roadmap_version_number} · {item.completed}{' '}
                      of {item.total} topics complete
                    </p>
                    <ProgressBar
                      value={item.percent}
                      label={item.cohort_name + ' completion'}
                    />
                    <Link
                      className="workspace-text-link"
                      to={roadmapUrl(item)}
                      aria-label={'Continue learning in ' + item.cohort_name}
                    >
                      Continue learning →
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="workspace-metric-grid">
            <MetricCard
              label="Enrolled cohorts"
              value={learning.length}
              detail="Active assignments"
              tone="green"
            />
            <MetricCard
              label="Topics completed"
              value={completed}
              detail={'Of ' + topics.size + ' distinct assigned topics'}
            />
            <MetricCard
              label="Still to explore"
              value={topics.size - completed}
              detail="Your unfinished topics"
            />
          </div>
          {!learning.length && (
            <EmptyState
              title="No assigned roadmap yet"
              description="Enter your coordinator's cohort code to begin."
              actionTo="/app/student/learning"
              actionLabel="Join a cohort"
            />
          )}
          {!!learning.length && (
            <section className="workspace-card workspace-feature-card">
              <p className="workspace-card-label">Next step</p>
              <h2>{next?.title || 'All assigned topics completed'}</h2>
              <p>
                {next?.description ||
                  'Open your roadmap to review your saved progress.'}
              </p>
              <Link
                className="workspace-text-link"
                to={roadmapUrl(nextAssignment)}
              >
                View assigned roadmap →
              </Link>
            </section>
          )}
          <Link className="workspace-text-link" to="/review">
            Open the separately labeled illustrative review →
          </Link>
        </>
      )}
    </div>
  )
}
