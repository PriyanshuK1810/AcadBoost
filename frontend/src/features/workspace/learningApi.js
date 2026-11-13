import { apiRequest } from '../../shared/api/client'
export function getMyActivity(cursor) {
  return apiRequest(
    '/progress/me/activity' +
      (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
  )
}
export function getCohortActivity(cohortId, cursor) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/activity` +
      (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
  )
}
export function getMyDeadlines() {
  return apiRequest('/progress/me/deadlines')
}
export function getCohortDeadlines(cohortId) {
  return apiRequest(`/cohorts/${encodeURIComponent(cohortId)}/deadlines`)
}
export function setWeekDeadline(cohortId, weekId, changes) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/weeks/${encodeURIComponent(weekId)}/deadline`,
    { method: 'PUT', body: JSON.stringify(changes) },
  )
}
export function removeWeekDeadline(cohortId, weekId) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/weeks/${encodeURIComponent(weekId)}/deadline`,
    { method: 'DELETE' },
  )
}
export function listOrganizations() {
  return apiRequest('/organizations')
}
export function getOrganization(organizationId) {
  return apiRequest(`/organizations/${encodeURIComponent(organizationId)}`)
}
export function listOrganizationMembers(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/members`,
  )
}
export function updateOrganizationMember(
  organizationId,
  membershipId,
  changes,
) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(changes),
    },
  )
}
export function transferOrganizationOwnership(organizationId, membershipId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/ownership-transfer`,
    {
      method: 'POST',
      body: JSON.stringify({ membership_id: membershipId }),
    },
  )
}
export function listOrganizationInvitations(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/invitations`,
  )
}
export function createOrganizationInvitation(organizationId, email, role) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/invitations`,
    {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    },
  )
}
export function revokeOrganizationInvitation(organizationId, invitationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
    {
      method: 'DELETE',
    },
  )
}
export function acceptOrganizationInvitation(code) {
  return apiRequest('/organization-invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}
export function createOrganization(name) {
  return apiRequest('/organizations', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}
export function listRoadmaps(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/roadmaps`,
  )
}
export function createRoadmap(organizationId, input) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/roadmaps`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}
function encodeRoadmapPathId(id) {
  const segment = encodeURIComponent(id)
  if (segment === '.' || segment === '..') {
    throw new TypeError('Invalid roadmap path ID')
  }
  return segment
}

const versionsPath = (organizationId, roadmapId) =>
  `/organizations/${encodeRoadmapPathId(organizationId)}/roadmaps/${encodeRoadmapPathId(roadmapId)}/versions`

const versionPath = (organizationId, roadmapId, versionId) =>
  `${versionsPath(organizationId, roadmapId)}/${encodeRoadmapPathId(versionId)}`

function revisionBody(revision) {
  if (revision == null) {
    throw new TypeError('A current roadmap version revision is required')
  }
  return { revision }
}

function decisionBody(revision, submissionId) {
  const body = revisionBody(revision)
  if (submissionId == null || submissionId === '') {
    throw new TypeError('A pending roadmap submission ID is required')
  }
  return { ...body, submission_id: submissionId }
}

function postVersionAction(organizationId, roadmapId, versionId, action, body) {
  return apiRequest(
    `${versionPath(organizationId, roadmapId, versionId)}/${action}`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

export function listRoadmapVersions(organizationId, roadmapId) {
  return apiRequest(versionsPath(organizationId, roadmapId))
}
export function saveRoadmapDraft(
  organizationId,
  roadmapId,
  versionId,
  phases,
  revision,
) {
  return apiRequest(versionPath(organizationId, roadmapId, versionId), {
    method: 'PUT',
    body: JSON.stringify({ ...revisionBody(revision), phases }),
  })
}
export function copyRoadmapVersion(
  organizationId,
  roadmapId,
  sourceVersionId,
  revision,
) {
  return apiRequest(versionsPath(organizationId, roadmapId), {
    method: 'POST',
    body: JSON.stringify({
      ...revisionBody(revision),
      source_version_id: sourceVersionId,
    }),
  })
}
export function submitRoadmapVersion(
  organizationId,
  roadmapId,
  versionId,
  revision,
) {
  return postVersionAction(
    organizationId,
    roadmapId,
    versionId,
    'submit',
    revisionBody(revision),
  )
}
export function approveRoadmapVersion(
  organizationId,
  roadmapId,
  versionId,
  revision,
  submissionId,
) {
  return postVersionAction(
    organizationId,
    roadmapId,
    versionId,
    'approve',
    decisionBody(revision, submissionId),
  )
}
export function publishRoadmapVersion(
  organizationId,
  roadmapId,
  versionId,
  revision,
  submissionId,
) {
  return postVersionAction(
    organizationId,
    roadmapId,
    versionId,
    'publish',
    decisionBody(revision, submissionId),
  )
}
export function rejectRoadmapVersion(
  organizationId,
  roadmapId,
  versionId,
  revision,
  submissionId,
  reason,
) {
  return postVersionAction(organizationId, roadmapId, versionId, 'reject', {
    ...decisionBody(revision, submissionId),
    reason,
  })
}
export function archiveRoadmapVersion(
  organizationId,
  roadmapId,
  versionId,
  revision,
) {
  return postVersionAction(
    organizationId,
    roadmapId,
    versionId,
    'archive',
    revisionBody(revision),
  )
}
export function listRoadmapReviews(
  organizationId,
  roadmapId,
  versionId,
  { limit = 20, offset = 0 } = {},
) {
  const query = new URLSearchParams({ limit, offset })
  return apiRequest(
    `${versionPath(organizationId, roadmapId, versionId)}/reviews?${query}`,
  )
}
export function listCohorts(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/cohorts`,
  )
}
export function createCohort(organizationId, name, roadmapVersionId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/cohorts`,
    {
      method: 'POST',
      body: JSON.stringify({ name, roadmap_version_id: roadmapVersionId }),
    },
  )
}
export function joinCohort(inviteCode) {
  return apiRequest('/cohorts/join', {
    method: 'POST',
    body: JSON.stringify({ invite_code: inviteCode }),
  })
}
export function rotateCohortJoinCode(cohortId) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/join-code/rotate`,
    {
      method: 'POST',
    },
  )
}
export function revokeCohortJoinCode(cohortId) {
  return apiRequest(`/cohorts/${encodeURIComponent(cohortId)}/join-code`, {
    method: 'DELETE',
  })
}
export function getCohortEnrollments(cohortId) {
  return apiRequest(`/cohorts/${encodeURIComponent(cohortId)}/enrollments`)
}
export function removeCohortEnrollment(cohortId, enrollmentId) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/enrollments/${encodeURIComponent(enrollmentId)}`,
    { method: 'DELETE' },
  )
}
export function reactivateCohortEnrollment(cohortId, enrollmentId) {
  return apiRequest(
    `/cohorts/${encodeURIComponent(cohortId)}/enrollments/${encodeURIComponent(enrollmentId)}/reactivate`,
    { method: 'POST' },
  )
}
export function withdrawFromCohort(cohortId) {
  return apiRequest(`/cohorts/${encodeURIComponent(cohortId)}/enrollments/me`, {
    method: 'DELETE',
  })
}
export function getMyLearning() {
  return apiRequest('/progress/me')
}
export function setTopicProgress(topicId, completed) {
  return apiRequest(`/progress/topics/${encodeURIComponent(topicId)}`, {
    method: 'PUT',
    body: JSON.stringify({ completed }),
  })
}
export function getCohortProgress(cohortId) {
  return apiRequest(`/cohorts/${encodeURIComponent(cohortId)}/progress`)
}

export function listMentorCohorts(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/mentor/cohorts`,
  )
}
export function getMentorCohort(organizationId, cohortId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/mentor/cohorts/${encodeURIComponent(cohortId)}`,
  )
}
export function listMentorAssignments(organizationId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/mentor-assignments`,
  )
}
export function assignMentor(organizationId, cohortId, membershipId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/cohorts/${encodeURIComponent(cohortId)}/mentor-assignments/${encodeURIComponent(membershipId)}`,
    { method: 'PUT' },
  )
}
export function revokeMentorAssignment(organizationId, cohortId, membershipId) {
  return apiRequest(
    `/organizations/${encodeURIComponent(organizationId)}/cohorts/${encodeURIComponent(cohortId)}/mentor-assignments/${encodeURIComponent(membershipId)}`,
    { method: 'DELETE' },
  )
}
