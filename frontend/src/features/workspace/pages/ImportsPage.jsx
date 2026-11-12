import { useSearchParams } from 'react-router'
import { EmptyState, PageHeading } from '../components/WorkspaceUI'
import { withOrganization } from '../hooks/useOrganizationScope'

export default function ImportsPage() {
  const [params] = useSearchParams()
  return (
    <>
      <PageHeading
        eyebrow="Coordinator / Imports"
        title="Student imports"
        description="Review the available way to enroll students in a cohort."
      />
      <EmptyState
        title="CSV roster import is unavailable"
        description="Students can join through a cohort’s join code. Open Live learning to manage cohort enrollment."
        actionLabel="Open Live learning"
        actionTo={withOrganization(
          '/app/coordinator/learning',
          params.get('organizationId'),
        )}
      />
    </>
  )
}
