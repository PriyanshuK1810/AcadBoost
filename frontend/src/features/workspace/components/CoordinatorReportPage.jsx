import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { listCohorts, listRoadmaps, getCohortProgress } from '../learningApi'
import { useLiveResource } from '../hooks/useLiveResource'
import {
  learningRoles,
  useOrganizationScope,
  withOrganization,
} from '../hooks/useOrganizationScope'
import LiveResourceState from './LiveResourceState'
import { EmptyState, MetricCard, PageHeading } from './WorkspaceUI'
import ReportProgressTable from './ReportProgressTable'

const titles = {
  overview: 'Your cohorts at a glance',
  cohorts: 'Cohorts',
  students: 'Student progress',
  topics: 'Topic statistics',
  support: 'Students to support',
}
export default function CoordinatorReportPage({ view = 'overview' }) {
  const scope = useOrganizationScope()
  const { organization, organizations, loading, error, requestedId } = scope
  const allowed = organization && learningRoles.includes(organization.role)
  return (
    <>
      {!allowed && (
        <PageHeading
          eyebrow="Coordinator / Live reporting"
          title={titles[view]}
        />
      )}
      <LiveResourceState {...scope} />
      {!loading &&
        !error &&
        !organization &&
        (requestedId !== null ? (
          <p className="form-error" role="alert">
            This organization is unavailable.
          </p>
        ) : (
          <EmptyState
            title="No active organization yet"
            description="Create an organization or accept a staff invitation to begin."
            actionLabel="Organization setup"
            actionTo="/app/organizations"
          />
        ))}
      {organization && !allowed && (
        <p className="form-error" role="alert">
          Your role cannot access reports for {organization.name}.
        </p>
      )}
      {allowed && (
        <OrganizationReport
          key={organization.id}
          view={view}
          organization={organization}
          scope={scope}
          organizations={organizations}
        />
      )}
    </>
  )
}

function OrganizationReport({ view, organization, scope, organizations }) {
  const organizationId = organization.id
  const [params, setParams] = useSearchParams()
  const requestedCohort = params.get('cohortId')
  const loadCohorts = useCallback(
    async () =>
      (await listCohorts(organizationId)).filter(
        (cohort) =>
          !cohort.organization_id || cohort.organization_id === organizationId,
      ),
    [organizationId],
  )
  const cohorts = useLiveResource(loadCohorts)
  const loadRoadmaps = useCallback(
    () =>
      cohorts.data?.length === 0
        ? listRoadmaps(organizationId)
        : Promise.resolve([]),
    [organizationId, cohorts.data],
  )
  const roadmaps = useLiveResource(loadRoadmaps)
  const hasPublished = roadmaps.data?.some((r) => r.status === 'published')
  const matchedCohort = cohorts.data?.find(({ id }) => id === requestedCohort)
  const cohort = matchedCohort ?? cohorts.data?.[0]
  const cohortId = cohort?.id ?? ''
  const assignedVersionId = cohort?.roadmap_version_id
  function selectCohort(id) {
    if (!cohorts.data?.some((item) => item.id === id)) return
    const next = new URLSearchParams(params)
    next.set('organizationId', organizationId)
    next.set('cohortId', id)
    setParams(next)
  }
  const loadReport = useCallback(async () => {
    if (!cohortId) return null
    const report = await getCohortProgress(cohortId)
    if (
      report?.cohort_id !== cohortId ||
      (assignedVersionId && report.roadmap_version_id !== assignedVersionId)
    )
      throw new Error('This cohort report could not be confirmed.')
    return report
  }, [assignedVersionId, cohortId])
  const resource = useLiveResource(loadReport)
  const report = resource.data
  const metrics = report?.metrics
  const assignments = metrics?.possible_topic_assignments
  return (
    <>
      <PageHeading
        eyebrow="Coordinator / Live reporting"
        title={titles[view]}
        description={`Current saved completion for ${organization.name}.`}
        action={
          !!cohorts.data?.length && (
            <Link
              className="workspace-button"
              to={withOrganization('/app/coordinator/learning', organizationId)}
            >
              Manage live learning
            </Link>
          )
        }
      />
      <>
        <div className="workspace-card report-selectors">
          {!scope.managed && (
            <label>
              Organization
              <select
                value={organizationId}
                onChange={(event) =>
                  scope.selectOrganization(event.target.value)
                }
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <LiveResourceState {...cohorts} />
          {!!cohorts.data?.length && (
            <label>
              Cohort
              <select
                value={cohortId}
                onChange={(event) => selectCohort(event.target.value)}
              >
                {cohorts.data.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {requestedCohort && cohorts.data && !matchedCohort && (
          <div className="workspace-inline-actions">
            <p role="status" aria-label="Cohort selection">
              The requested cohort is unavailable in this organization.
              {cohort && ' Showing the first available cohort.'}
            </p>
            <button
              type="button"
              className="workspace-button workspace-button-outline"
              onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('cohortId')
                setParams(next, { replace: true })
              }}
            >
              Reset cohort filter
            </button>
          </div>
        )}
        {!cohorts.loading && !cohorts.error && !cohorts.data?.length && (
          <EmptyState
            title="No active cohorts"
            description="Create a cohort with a published roadmap to start reporting."
            actionLabel={hasPublished ? 'Create a cohort' : 'Prepare a roadmap'}
            actionTo={withOrganization(
              hasPublished
                ? '/app/coordinator/learning'
                : '/app/coordinator/roadmaps',
              organizationId,
            )}
          />
        )}
        {view === 'cohorts' &&
          cohorts.data?.map((cohort) => (
            <article className="workspace-card" key={cohort.id}>
              <h2>{cohort.name}</h2>
              <p>
                {cohort.roadmap_name} · {cohort.student_count} active
                enrollments
              </p>
              <Link
                to={withOrganization(
                  '/app/coordinator/learning/' + cohort.id,
                  organizationId,
                )}
              >
                Open cohort report →
              </Link>
            </article>
          ))}
        {!!cohortId && <LiveResourceState {...resource} />}
        {report && (
          <>
            <section className="workspace-card">
              <h2>{report.cohort_name}</h2>
              <p>
                {report.roadmap_name} · Assigned Version{' '}
                {report.roadmap_version_number ?? 'unavailable'}
              </p>
              <p>
                All-time current completion. Includes active student accounts
                with active student membership and enrollment, including
                students with no saved progress.
              </p>
              <div className="workspace-inline-actions">
                <button className="workspace-button" onClick={resource.retry}>
                  Refresh report
                </button>
                <Link
                  className="workspace-text-link"
                  to={withOrganization(
                    '/app/coordinator/learning/' + cohortId,
                    organizationId,
                  )}
                >
                  Open cohort details →
                </Link>
              </div>
            </section>
            <div className="workspace-metric-grid">
              <MetricCard
                label="Eligible students"
                value={metrics?.eligible_students ?? 'Unavailable'}
                detail="Active members and enrollments"
                tone="green"
              />
              <MetricCard
                label="Average completion"
                value={
                  assignments > 0 && Number.isFinite(report.average_percent)
                    ? report.average_percent + '%'
                    : '—'
                }
                detail={
                  assignments === 0
                    ? 'No eligible student–topic assignments'
                    : assignments > 0 &&
                        Number.isFinite(metrics.completed_topic_assignments)
                      ? `${metrics.completed_topic_assignments} / ${assignments} completed topic assignments`
                      : 'Completion totals are unavailable'
                }
              />
              <MetricCard
                label="Below cohort average"
                value={
                  Array.isArray(report.students) &&
                  report.students.every(
                    (student) => typeof student.below_average === 'boolean',
                  )
                    ? report.students.filter((student) => student.below_average)
                        .length
                    : 'Unavailable'
                }
                detail="A prompt for a personal check-in"
              />
            </div>
            {metrics?.eligible_students === 0 && (
              <EmptyState
                title="No eligible students yet"
                description="Share the join code, and check that student memberships and accounts are active."
              />
            )}
            {view === 'support' && (
              <p>
                Suggested check-ins use the server’s exact cohort average.
                Displayed percentages are rounded.
              </p>
            )}
            {['overview', 'students', 'support'].includes(view) && (
              <StudentReport
                rows={report.students}
                support={view === 'support'}
              />
            )}
            {['overview', 'topics'].includes(view) && (
              <section className="workspace-card learning-report">
                <h2>Topic completion</h2>
                <ReportProgressTable rows={report.topics} />
              </section>
            )}
          </>
        )}
      </>
    </>
  )
}

function StudentReport({ rows, support }) {
  const [search, setSearch] = useState('')
  const students = Array.isArray(rows)
    ? rows.filter(
        (student) =>
          (!support || student.below_average) &&
          student.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : undefined
  return (
    <section className="workspace-card learning-report">
      <h2>{support ? 'Suggested check-ins' : 'Student progress'}</h2>
      {students && rows.length > 0 && (
        <label>
          Find a student
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      )}
      <ReportProgressTable rows={students} students />
      {students && rows.length > 0 && !students.length && (
        <p role="status">No students match this view.</p>
      )}
    </section>
  )
}
