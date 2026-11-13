import { requireOrganizationRole } from '../../core/authorization.js';
import { conflict, notFound, unauthorized } from '../../core/errors.js';
import { findAccessSession } from '../auth/service.js';

const minimumStudents = 5;
const pinnedStatuses = ['published', 'archived'];
const snapshot = { isolationLevel: 'RepeatableRead' };
const activeMentor = {
  role: 'mentor', status: 'active', user: { status: 'active', accountType: 'coordinator' },
};
const organizationPath = '/api/v1/organizations/:organizationId';
const assignmentPath = organizationPath + '/cohorts/:cohortId/mentor-assignments';
const mentorPath = organizationPath + '/mentor/cohorts';

const assignmentSelect = { id: true, cohortId: true, membershipId: true, assignedAt: true };
const assignmentOut = (row) => ({
  id: row.id, cohort_id: row.cohortId, membership_id: row.membershipId, assigned_at: row.assignedAt,
});
const cohortSelect = {
  id: true, organizationId: true, name: true, roadmapVersionId: true,
  roadmapVersion: { select: { versionNumber: true, roadmap: { select: { name: true } } } },
};
const cohortOut = (row) => ({
  id: row.id, organization_id: row.organizationId, name: row.name, roadmap_version_id: row.roadmapVersionId,
  roadmap_name: row.roadmapVersion.roadmap.name, roadmap_version_number: row.roadmapVersion.versionNumber,
});
const activeCohort = (organizationId) => ({
  organizationId, status: 'active',
  roadmapVersion: { status: { in: pinnedStatuses }, roadmap: { organizationId } },
});

async function audit(tx, request, action, organizationId, assignment) {
  await tx.auditEvent.create({ data: {
    organizationId, actorId: request.user.id, action, entityType: 'mentor_cohort_assignment',
    entityId: assignment.id, requestId: request.requestId,
    metadata: { cohort_id: assignment.cohortId, membership_id: assignment.membershipId },
  } });
}

export function registerMentorRoutes(app, {
  prisma, settings, requireUser, uuidParam, lockOrganization, roadmapTree, eligibleStudentIds, percent,
}) {
  async function requireLiveRole(db, request, organizationId, role) {
    const eligible = await findAccessSession(db, settings, request, {
      userId: request.user.id, sessionId: request.authSession.id,
    });
    if (!eligible) throw unauthorized('Invalid or expired access credential');
    const { user } = eligible;
    return requireOrganizationRole(db, { id: user.id, account_type: user.accountType }, organizationId, [role]);
  }

  function listAssignments(scoped) {
    return async (request, response) => {
      const organizationId = uuidParam(request, 'organizationId');
      const cohortId = scoped ? uuidParam(request, 'cohortId') : undefined;
      const result = await prisma.$transaction(async (tx) => {
        await requireLiveRole(tx, request, organizationId, 'owner');
        const cohorts = await tx.cohort.findMany({
          where: { ...activeCohort(organizationId), ...(cohortId && { id: cohortId }) },
          select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        if (cohortId && !cohorts.length) throw notFound('Cohort not found');
        const assignments = await tx.mentorCohortAssignment.findMany({
          where: { organizationId, ...(cohortId && { cohortId }), revokedAt: null },
          select: { ...assignmentSelect, membership: { select: { user: { select: { displayName: true } } } } },
          orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
        });
        const mentors = await tx.organizationMembership.findMany({
          where: { organizationId, ...activeMentor },
          select: { id: true, user: { select: { displayName: true } } },
          orderBy: [{ user: { displayName: 'asc' } }, { id: 'asc' }],
        });
        return {
          assignments: assignments.map((row) => ({ ...assignmentOut(row), mentor_name: row.membership.user.displayName })),
          mentors: mentors.map((row) => ({ id: row.id, display_name: row.user.displayName })),
          cohorts,
        };
      }, snapshot);
      response.set('Cache-Control', 'no-store').json(result);
    };
  }

  function mutate(revoke) {
    return async (request, response) => {
      const organizationId = uuidParam(request, 'organizationId');
      const cohortId = uuidParam(request, 'cohortId');
      const membershipId = uuidParam(request, 'membershipId');
      const assignment = await prisma.$transaction(async (tx) => {
        await lockOrganization(tx, organizationId);
        await requireOrganizationRole(tx, request.user, organizationId, ['owner']);
        const cohort = await tx.cohort.findFirst({
          where: { id: cohortId, ...(revoke ? { organizationId } : activeCohort(organizationId)) },
          select: { id: true },
        });
        if (!cohort) throw notFound('Cohort not found');
        const member = await tx.organizationMembership.findFirst({
          where: { id: membershipId, organizationId }, select: { userId: true },
        });
        if (!member) throw notFound('Membership not found');
        // The organization lock also serializes the existing membership mutations.
        await tx.$queryRaw`SELECT id FROM users WHERE id IN (${request.user.id}::uuid, ${member.userId}::uuid) ORDER BY id FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${request.authSession.id}::uuid FOR SHARE`;
        await requireLiveRole(tx, request, organizationId, 'owner');
        if (!revoke && !await tx.organizationMembership.findFirst({
          where: { id: membershipId, organizationId, ...activeMentor }, select: { id: true },
        })) throw conflict('Assignment requires an active Mentor membership');

        const existing = await tx.mentorCohortAssignment.findFirst({
          where: { organizationId, cohortId, membershipId, revokedAt: null }, select: assignmentSelect,
        });
        if (revoke) {
          if (existing) {
            await tx.$executeRaw`UPDATE mentor_cohort_assignments
              SET revoked_at = GREATEST(clock_timestamp(), assigned_at), revoked_by = ${request.user.id}::uuid
              WHERE id = ${existing.id}::uuid`;
            await audit(tx, request, 'mentor_assignment.revoked', organizationId, existing);
          }
          return null;
        }
        if (existing) return existing;
        const created = await tx.mentorCohortAssignment.create({
          data: { organizationId, cohortId, membershipId, assignedBy: request.user.id },
          select: assignmentSelect,
        });
        await audit(tx, request, 'mentor_assignment.assigned', organizationId, created);
        return created;
      });
      response.set('Cache-Control', 'no-store');
      if (revoke) response.status(204).end();
      else response.json(assignmentOut(assignment));
    };
  }

  app.get(organizationPath + '/mentor-assignments', requireUser, listAssignments(false));
  app.get(assignmentPath, requireUser, listAssignments(true));
  app.put(assignmentPath + '/:membershipId', requireUser, mutate(false));
  app.delete(assignmentPath + '/:membershipId', requireUser, mutate(true));

  async function assignedCohorts(tx, request, organizationId, cohortId) {
    const { membership } = await requireLiveRole(tx, request, organizationId, 'mentor');
    const rows = await tx.mentorCohortAssignment.findMany({
      where: { organizationId, membershipId: membership.id, revokedAt: null,
        cohort: { ...activeCohort(organizationId), ...(cohortId && { id: cohortId }) },
      },
      select: { cohort: { select: cohortSelect } },
      orderBy: [{ cohort: { name: 'asc' } }, { cohortId: 'asc' }],
    });
    return rows.map((row) => row.cohort);
  }

  app.get(mentorPath, requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const rows = await prisma.$transaction((tx) => assignedCohorts(tx, request, organizationId), snapshot);
    response.set('Cache-Control', 'no-store').json(rows.map(cohortOut));
  });

  app.get(mentorPath + '/:cohortId', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const cohortId = uuidParam(request, 'cohortId');
    const result = await prisma.$transaction(async (tx) => {
      const [cohort] = await assignedCohorts(tx, request, organizationId, cohortId);
      if (!cohort) throw notFound('Assigned cohort not found');
      const phases = await roadmapTree(tx, cohort.roadmapVersionId);
      const weeks = phases.flatMap((phase) => phase.weeks);
      const topicIds = weeks.flatMap((week) => week.topics.map((topic) => topic.id));
      const eligibleIds = await eligibleStudentIds(tx, cohort);
      const students = eligibleIds.length ? await tx.user.findMany({
        where: { id: { in: eligibleIds }, status: 'active', accountType: 'student' },
        select: { id: true },
      }) : [];
      const suppressed = students.length < minimumStudents;
      const completed = suppressed ? null : await tx.topicProgress.count({
        where: { userId: { in: students.map(({ id }) => id) }, topicId: { in: topicIds }, status: 'completed' },
      });
      const possible = suppressed ? null : students.length * topicIds.length;
      const deadlines = await tx.cohortWeekDeadline.findMany({
        where: { cohortId, weekId: { in: weeks.map(({ id }) => id) } },
        select: { weekId: true, dueAt: true, timeZone: true },
        orderBy: [{ dueAt: 'asc' }, { weekId: 'asc' }],
      });
      return {
        cohort: cohortOut(cohort), phases,
        progress: {
          suppressed, minimum_eligible_students: minimumStudents,
          eligible_students: suppressed ? null : students.length, topics: topicIds.length,
          completed_topic_assignments: completed, possible_topic_assignments: possible,
          percent: suppressed ? null : percent(completed, possible), as_of: new Date(),
        },
        deadlines: deadlines.map((row) => ({ week_id: row.weekId, due_at: row.dueAt, time_zone: row.timeZone })),
      };
    }, snapshot);
    response.set('Cache-Control', 'no-store').json(result);
  });
}
