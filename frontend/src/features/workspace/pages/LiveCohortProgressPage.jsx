import { useCallback } from 'react'
import { useLiveResource } from '../hooks/useLiveResource'
import LiveResourceState from '../components/LiveResourceState'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import { EmptyState, MetricCard, PageHeading } from '../components/WorkspaceUI'
import ReportProgressTable from '../components/ReportProgressTable'
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
        const cohort = cohorts.find(
          (item) => item.id === cohortId && item.organization_id === id,
        )
        if (cohort) return cohort
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
          membership.data.organization_id,
        )}
      />
    )
  }
  return (
    <CohortProgress
      cohortId={cohortId}
      organization={organization}
      assignedVersionId={membership.data.roadmap_version_id}
    />
  )
}

function CohortProgress({ cohortId, organization, assignedVersionId }) {
  const loader = useCallback(async () => {
    const report = await getCohortProgress(cohortId)
    if (
      report?.cohort_id !== cohortId ||
      (assignedVersionId && report.roadmap_version_id !== assignedVersionId)
    )
      throw new Error('This cohort report could not be confirmed.')
    return report
  }, [assignedVersionId, cohortId])
  const resource = useLiveResource(loader)
  const report = resource.data
  const assignments = report?.metrics?.possible_topic_assignments
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
              Assigned version {report.roadmap_version_number ?? 'unavailable'}{' '}
              · All-time current completion
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
              label="Eligible students"
              value={report.metrics?.eligible_students ?? 'Unavailable'}
              detail="Active student accounts, memberships and enrollments"
              tone="green"
            />
            <MetricCard
              label="Average completion"
              value={
                assignments > 0 && Number.isFinite(report.average_percent)
                  ? `${report.average_percent}%`
                  : '—'
              }
              detail={
                assignments === 0
                  ? 'No eligible student–topic assignments'
                  : assignments > 0 &&
                      Number.isFinite(
                        report.metrics.completed_topic_assignments,
                      )
                    ? `${report.metrics.completed_topic_assignments} / ${assignments} completed topic assignments`
                    : 'Completion totals are unavailable'
              }
            />
            <MetricCard
              label="Topics"
              value={report.metrics?.topics ?? 'Unavailable'}
              detail="Assigned roadmap version"
            />
          </div>
          {report.metrics?.eligible_students === 0 ? (
            <EmptyState
              title="No eligible students yet"
              description="Share the join code and check that student memberships and accounts are active."
            />
          ) : (
            <section className="workspace-card learning-report">
              <h2>Student progress</h2>
              <ReportProgressTable rows={report.students} students />
            </section>
          )}
          <section className="workspace-card learning-report">
            <h2>Topic completion</h2>
            <ReportProgressTable rows={report.topics} />
          </section>
        </>
      )}
      {report && <CohortSchedule key={cohortId} cohortId={cohortId} />}
    </>
  )
}
