import { useCallback } from 'react'
import { useLiveResource } from '../hooks/useLiveResource'
import LiveResourceState from '../components/LiveResourceState'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import {
  EmptyState,
  MetricCard,
  PageHeading,
  ProgressBar,
} from '../components/WorkspaceUI'
import CohortSchedule from '../components/CohortSchedule'
import { getCohortProgress, listCohorts } from '../learningApi'
import {
  learningRoles,
  useOrganizationScope,
  withOrganization,
} from '../hooks/useOrganizationScope'
export default function LiveCohortProgressPage() {
  const { cohortId } = useParams()
  const scope = useOrganizationScope()
  if (!scope.managed && scope.requestedId === null) {
    return <CohortProgress key={cohortId} cohortId={cohortId} />
  }
  if (scope.loading || scope.error) return <LiveResourceState {...scope} />
  return (
    <CohortAccess
      key={JSON.stringify([cohortId, scope.requestedId])}
      cohortId={cohortId}
      scope={scope}
    />
  )
}

function CohortAccess({ cohortId, scope }) {
  const location = useLocation()
  const { organization, organizations, requestedId } = scope
  const candidates =
    requestedId === null ? organizations : organization ? [organization] : []
  const candidateIds = JSON.stringify(
    candidates
      .filter(({ role }) => learningRoles.includes(role))
      .map(({ id }) => id),
  )
  const verify = useCallback(async () => {
    let firstError
    for (const id of JSON.parse(candidateIds)) {
      try {
        const cohorts = await listCohorts(id)
        if (
          cohorts.some(
            (item) => item.id === cohortId && item.organization_id === id,
          )
        )
          return id
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
    return null
  }, [candidateIds, cohortId])
  const membership = useLiveResource(verify)
  if (membership.loading || membership.error)
    return <LiveResourceState {...membership} />
  if (!membership.data) {
    return (
      <EmptyState
        title="Cohort unavailable"
        description="This cohort is unavailable in the selected organization."
        actionLabel="Back to live learning"
        actionTo={withOrganization(
          '/app/coordinator/learning',
          organization?.id,
        )}
      />
    )
  }
  if (requestedId === null) {
    return (
      <Navigate
        replace
        to={withOrganization(
          location.pathname + location.search + location.hash,
          membership.data,
        )}
      />
    )
  }
  return <CohortProgress cohortId={cohortId} organization={organization} />
}

function CohortProgress({ cohortId, organization }) {
  const loader = useCallback(async () => {
    const report = await getCohortProgress(cohortId)
    if (report.cohort_id && report.cohort_id !== cohortId)
      throw new Error('This cohort report could not be confirmed.')
    return report
  }, [cohortId])
  const resource = useLiveResource(loader)
  const report = resource.data
  return (
    <>
      <PageHeading
        eyebrow="Coordinator / Live progress"
        title={report?.cohort_name || 'Cohort progress'}
        description={
          report
            ? `Real progress for ${report.roadmap_name}${organization ? ` at ${organization.name}` : ''}. Refresh to see students' latest updates.`
            : 'Review real student topic completion.'
        }
        action={
          <Link
            className="workspace-button"
            to={withOrganization('/app/coordinator/learning', organization?.id)}
          >
            Back to setup
          </Link>
        }
      />
      <LiveResourceState {...resource} />
      {report && (
        <>
          <section className="workspace-card">
            <p>
              Version {report.roadmap_version_number} · All-time current
              completion
            </p>
            <p>
              Eligible students have an active account, student membership and
              enrollment. Students with zero progress are included.
            </p>
            <button className="workspace-button" onClick={resource.retry}>
              Refresh report
            </button>
          </section>
          <div className="workspace-metric-grid">
            <MetricCard
              label="Students"
              value={report.students.length}
              detail="Active student accounts and memberships"
              tone="green"
            />
            <MetricCard
              label="Average completion"
              value={`${report.average_percent}%`}
              detail={
                report.metrics
                  ? `${report.metrics.completed_topic_assignments} / ${report.metrics.possible_topic_assignments} completed topic assignments`
                  : 'Across eligible students'
              }
            />
            <MetricCard
              label="Topics"
              value={report.topics.length}
              detail="Published roadmap version"
            />
          </div>
          {report.students.length === 0 ? (
            <EmptyState
              title="No students have joined"
              description="Share the cohort join code shown on the setup page."
            />
          ) : (
            <section className="workspace-card learning-report">
              <h2>Student progress</h2>
              {report.students.map((student) => (
                <div className="learning-report-row" key={student.id}>
                  <div>
                    <strong>{student.name}</strong>
                    <span>
                      {student.completed} / {student.total} topics
                    </span>
                  </div>
                  <ProgressBar
                    value={student.percent}
                    label={`${student.name} completion`}
                  />
                  <strong>{student.percent}%</strong>
                </div>
              ))}
            </section>
          )}
          <section className="workspace-card learning-report">
            <h2>Topic completion</h2>
            {report.topics.map((topic) => (
              <div className="learning-report-row" key={topic.id}>
                <div>
                  <strong>{topic.title}</strong>
                  <span>
                    {topic.completed} / {topic.total} students
                  </span>
                </div>
                <ProgressBar
                  value={topic.percent}
                  label={`${topic.title} completion`}
                />
                <strong>{topic.percent}%</strong>
              </div>
            ))}
          </section>
        </>
      )}
      {report && <CohortSchedule key={cohortId} cohortId={cohortId} />}
    </>
  )
}
