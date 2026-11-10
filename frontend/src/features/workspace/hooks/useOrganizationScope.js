import { useContext, useMemo, useState } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router'
import { listOrganizations } from '../learningApi'
import { useLiveResource } from './useLiveResource'
import { WorkspaceContext } from './useWorkspace'

export const learningRoles = ['owner', 'admin', 'coordinator']
const skipMemberships = () => []

export function withOrganization(path, id) {
  if (!id) return path
  const [destination, hash] = path.split('#', 2)
  const [pathname, query] = destination.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('organizationId', id)
  return `${pathname}?${params}${hash ? `#${hash}` : ''}`
}

function detailRoute(pathname) {
  const organization = matchPath('/app/organizations/:organizationId', pathname)
  if (organization)
    return { organizationId: organization.params.organizationId }
  if (matchPath('/app/coordinator/learning/:cohortId', pathname)) {
    return { destination: '/app/coordinator/learning' }
  }
  if (
    matchPath('/app/coordinator/roadmaps/:roadmapId/versions', pathname) ||
    (matchPath('/app/coordinator/activity-plans/:planId', pathname) &&
      !matchPath('/app/coordinator/activity-plans/new', pathname))
  ) {
    return { destination: '/app/coordinator/roadmaps' }
  }
  return null
}

export function useOrganizationSelection(enabled) {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const memberships = useLiveResource(
    enabled ? listOrganizations : skipMemberships,
  )
  const [created, setCreated] = useState([])
  const available = useMemo(() => {
    const organizations = (memberships.data ?? []).filter(
      (item) => !item.status || item.status === 'active',
    )
    return [
      ...organizations,
      ...created.filter(
        (item) => !organizations.some(({ id }) => id === item.id),
      ),
    ]
  }, [memberships.data, created])
  const detail = detailRoute(pathname)
  const requestedId =
    detail?.organizationId ?? new URLSearchParams(search).get('organizationId')
  const organization =
    requestedId === null
      ? detail
        ? null
        : (available[0] ?? null)
      : (available.find((item) => item.id === requestedId) ?? null)

  function selectOrganization(id) {
    const next = available.find((item) => item.id === id)
    if (!next || id === organization?.id) return
    const destination = detail?.organizationId
      ? next.role === 'owner'
        ? `/app/organizations/${encodeURIComponent(id)}`
        : withOrganization('/app/organizations', id)
      : withOrganization(detail?.destination ?? pathname, id)
    navigate(destination)
  }

  function rememberOrganization(member) {
    setCreated((items) => [
      ...items.filter(({ id }) => id !== member.id),
      member,
    ])
    navigate(withOrganization(pathname, member.id))
  }

  function retry() {
    setCreated([])
    memberships.retry()
  }

  return {
    organizations: available,
    organization,
    requestedId,
    loading: enabled && memberships.loading,
    error: enabled ? memberships.error : '',
    errorStatus: memberships.errorStatus,
    selectOrganization,
    rememberOrganization,
    retry,
  }
}

export function useOrganizationScope() {
  const shared = useContext(WorkspaceContext)?.organizationScope
  const standalone = useOrganizationSelection(!shared)
  return shared ?? { ...standalone, managed: false }
}
