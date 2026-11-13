import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerRoadmapRoutes } from './roadmapRoutes.js';
import { registerActivityRoutes } from './activityRoutes.js';
import { registerMentorRoutes } from './mentorRoutes.js';
import { AppError, conflict, forbidden, notFound, notReady } from '../../core/errors.js';
import {
  hasAccountRoleCompatibility,
  LEARNING_RESOURCE_ROLES,
  requireAccountType,
  requireAssignedTopicAccess,
  requireCohortAccess,
  requireCohortScope,
  requireOrganizationRole,
  requirePublishedRoadmapVersion,
} from '../../core/authorization.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const cleanName = z.string().min(2).max(200).transform((value) => value.trim()).refine((value) => value.length >= 2);
const organizationInput = z.strictObject({ name: cleanName });
const cohortInput = z.strictObject({ name: cleanName, roadmap_version_id: uuid });
const joinInput = z.strictObject({ invite_code: z.string().min(20).max(64) });
const progressInput = z.strictObject({ completed: z.boolean() });
const memberInput = z.strictObject({
  role: z.enum(['coordinator', 'admin', 'mentor']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined);
const transferInput = z.strictObject({ membership_id: uuid });
const invitationInput = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: z.enum(['coordinator', 'admin', 'mentor']),
});
const acceptInvitationInput = z.strictObject({ code: z.string().min(40).max(128) });
const invitationDurationMs = 7 * 24 * 60 * 60 * 1000;
const codeDigest = (code) => createHash('sha256').update(code).digest('hex');
const cohortJoinCodeDurationMs = 7 * 24 * 60 * 60 * 1000;
const cohortJoinCodeRateWindowSeconds = 15 * 60;
const cohortJoinRateLimitScript = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;
const invitationOut = (row) => ({
  id: row.id, organization_id: row.organizationId, email: row.email, role: row.role,
  status: row.status === 'pending' && row.expiresAt <= new Date() ? 'expired' : row.status,
  expires_at: row.expiresAt, created_at: row.createdAt,
});

function joinCodeStatus(cohort, now = new Date()) {
  if (cohort.inviteCodeRevokedAt || !cohort.inviteCodeHash) return 'revoked';
  if (!cohort.inviteCodeExpiresAt || cohort.inviteCodeExpiresAt <= now) return 'expired';
  return 'active';
}

async function enforceCohortJoinRateLimit(redisClient, request, response, user) {
  if (!redisClient) throw notReady('Cohort join protection is temporarily unavailable');
  const identifiers = [
    ['ip', request.ip || request.socket?.remoteAddress || 'unknown', 30],
    ['account', user.id, 10],
  ];
  for (const [kind, identifier, limit] of identifiers) {
    const key = `outpost:cohort-join:${kind}:${codeDigest(identifier)}`;
    let count;
    try {
      const result = await redisClient.eval(cohortJoinRateLimitScript, {
        keys: [key], arguments: [String(cohortJoinCodeRateWindowSeconds)],
      });
      count = Number(result);
    } catch {
      throw notReady('Cohort join protection is temporarily unavailable');
    }
    if (!Number.isSafeInteger(count) || count < 1)
      throw notReady('Cohort join protection is temporarily unavailable');
    if (count > limit) {
      response.set('Retry-After', String(cohortJoinCodeRateWindowSeconds));
      throw new AppError(429, 'rate_limited', 'Too many cohort join attempts. Try again later.');
    }
  }
}

function parse(schema, value, location = 'body') {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(422, 'validation_error', 'Request validation failed',
    result.error.issues.map((issue) => ({
      loc: [location, ...issue.path],
      type: issue.code === 'unrecognized_keys' ? 'extra_forbidden' : issue.code,
    })));
}

function coordinator(user) {
  requireAccountType(user, ['coordinator']);
}
function student(user) {
  requireAccountType(user, ['student']);
}
async function owner(prisma, user, organizationId) {
  return (await requireOrganizationRole(prisma, user, organizationId, ['owner'])).organization;
}
async function learningStaff(prisma, user, organizationId) {
  return requireOrganizationRole(prisma, user, organizationId, LEARNING_RESOURCE_ROLES);
}
async function lockOrganization(tx, organizationId) {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
}
function sorted(rows, dateField = 'createdAt') {
  return [...rows].sort((a, b) => {
    const first = new Date(a[dateField]).getTime() - new Date(b[dateField]).getTime();
    return first || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
async function roadmapTree(prisma, versionId) {
  const phases = await prisma.phase.findMany({ where: { roadmapVersionId: versionId } });
  if (!phases.length) return [];
  const weeks = await prisma.week.findMany({ where: { phaseId: { in: phases.map((phase) => phase.id) } } });
  const topicRows = weeks.length
    ? await prisma.topic.findMany({ where: { weekId: { in: weeks.map((week) => week.id) } } })
    : [];
  const weeksByPhase = new Map(phases.map((phase) => [phase.id, []]));
  const topicsByWeek = new Map(weeks.map((week) => [week.id, []]));
  for (const week of weeks) weeksByPhase.get(week.phaseId).push(week);
  for (const topic of topicRows) topicsByWeek.get(topic.weekId).push(topic);
  return phases.sort((a, b) => a.orderIndex - b.orderIndex).map((phase) => ({
    id: phase.id, title: phase.title, order_index: phase.orderIndex,
    weeks: weeksByPhase.get(phase.id).sort((a, b) => a.orderIndex - b.orderIndex).map((week) => ({
      id: week.id, title: week.title, order_index: week.orderIndex,
      topics: topicsByWeek.get(week.id).sort((a, b) => a.orderIndex - b.orderIndex).map((topic) => ({
        id: topic.id, title: topic.title, description: topic.description, order_index: topic.orderIndex,
      })),
    })),
  }));
}
function flattenRoadmapTree(phases) {
  return phases.flatMap((phase) => phase.weeks.flatMap((week) => week.topics.map((topic) => ({
    id: topic.id, title: topic.title, description: topic.description, week: week.order_index,
  }))));
}
async function topics(prisma, versionId) {
  return flattenRoadmapTree(await roadmapTree(prisma, versionId));
}

async function cohortOut(prisma, cohort) {
  const version = await prisma.roadmapVersion.findUnique({ where: { id: cohort.roadmapVersionId } });
  const roadmap = version ? await prisma.roadmap.findUnique({ where: { id: version.roadmapId } }) : null;
  const count = await prisma.cohortEnrollment.count({ where: { cohortId: cohort.id, status: 'active' } });
  return {
    id: cohort.id, organization_id: cohort.organizationId, name: cohort.name,
    roadmap_version_id: cohort.roadmapVersionId, roadmap_name: roadmap?.name ?? 'Roadmap',
    join_code_status: joinCodeStatus(cohort), invite_code_expires_at: cohort.inviteCodeExpiresAt,
    student_count: count,
  };
}
function roundEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction > 0.5 || (fraction === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
}
function percent(completed, total) {
  return total ? roundEven(100 * completed / total) : 0;
}
function uuidParam(request, name) {
  return parse(uuid, request.params[name], 'path');
}

async function eligibleStudentIds(prisma, cohort) {
  const enrollments = await prisma.cohortEnrollment.findMany({
    where: { cohortId: cohort.id, status: 'active' }, select: { userId: true },
  });
  const memberships = enrollments.length ? await prisma.organizationMembership.findMany({
    where: { organizationId: cohort.organizationId, userId: { in: enrollments.map((row) => row.userId) },
      role: 'student', status: 'active' },
    select: { userId: true },
  }) : [];
  return memberships.map((row) => row.userId);
}

export function registerLearningRoutes(app, { prisma, settings, requireUser, redisClient }) {
  registerRoadmapRoutes(app, { prisma, requireUser });
  registerMentorRoutes(app, { prisma, settings, requireUser, uuidParam, lockOrganization, roadmapTree, eligibleStudentIds, percent });
  app.post('/api/v1/organizations', requireUser, async (request, response) => {
    const data = parse(organizationInput, request.body);
    coordinator(request.user);
    const slugBase = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 190) || 'organization';
    const result = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: data.name, slug: slugBase + '-' + randomBytes(5).toString('hex') },
      });
      await tx.organizationMembership.create({
        data: { organizationId: organization.id, userId: request.user.id, role: 'owner' },
      });
      return organization;
    });
    response.status(201).json({ id: result.id, name: result.name, role: 'owner' });
  });

  app.get('/api/v1/organizations', requireUser, async (request, response) => {
    const memberships = (await prisma.organizationMembership.findMany({
      where: { userId: request.user.id, status: 'active' },
    })).filter((membership) => hasAccountRoleCompatibility(request.user.account_type, membership.role));
    const organizations = memberships.length
      ? await prisma.organization.findMany({ where: { id: { in: memberships.map((row) => row.organizationId) }, status: 'active' } })
      : [];
    const byId = new Map(organizations.map((organization) => [organization.id, organization]));
    response.json(sorted(organizations).map((organization) => ({
      id: organization.id, name: organization.name,
      role: memberships.find((row) => row.organizationId === organization.id).role,
    })).filter((row) => byId.has(row.id)));
  });

  app.get('/api/v1/organizations/:organizationId', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const organization = await owner(prisma, request.user, organizationId);
    response.set('Cache-Control', 'no-store');
    response.json({ id: organization.id, name: organization.name, slug: organization.slug, role: 'owner' });
  });

  app.get('/api/v1/organizations/:organizationId/members', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    await owner(prisma, request.user, organizationId);
    const memberships = await prisma.organizationMembership.findMany({ where: { organizationId } });
    const users = memberships.length
      ? await prisma.user.findMany({
          where: { id: { in: memberships.map((membership) => membership.userId) } },
          select: { id: true, displayName: true, primaryEmail: true, accountType: true },
        })
      : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    response.set('Cache-Control', 'no-store');
    response.json(sorted(memberships, 'joinedAt').map((membership) => ({
      id: membership.id,
      user_id: membership.userId,
      display_name: byId.get(membership.userId)?.displayName ?? 'Unknown member',
      email: byId.get(membership.userId)?.primaryEmail ?? null,
      account_type: byId.get(membership.userId)?.accountType ?? null,
      role: membership.role,
      status: membership.status,
      joined_at: membership.joinedAt,
    })));
  });

  app.patch('/api/v1/organizations/:organizationId/members/:membershipId', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const membershipId = uuidParam(request, 'membershipId');
    const data = parse(memberInput, request.body);
    const changed = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await owner(tx, request.user, organizationId);
      const target = await tx.organizationMembership.findFirst({ where: { id: membershipId, organizationId } });
      if (!target) throw notFound('Membership not found');
      if (target.role === 'owner') throw forbidden('Transfer ownership before changing the owner');
      if (data.role) {
        const user = await tx.user.findUnique({ where: { id: target.userId } });
        if (!user || user.accountType !== 'coordinator' || user.status !== 'active')
          throw forbidden('Staff role requires an active coordinator account');
      }
      const result = await tx.organizationMembership.update({ where: { id: target.id }, data });
      return { id: result.id, user_id: result.userId, role: result.role, status: result.status };
    });
    response.set('Cache-Control', 'no-store').json(changed);
  });

  app.delete('/api/v1/organizations/:organizationId/members/:membershipId', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const membershipId = uuidParam(request, 'membershipId');
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await owner(tx, request.user, organizationId);
      const target = await tx.organizationMembership.findFirst({ where: { id: membershipId, organizationId } });
      if (!target) throw notFound('Membership not found');
      if (target.role === 'owner') throw forbidden('Transfer ownership before removing the owner');
      await tx.organizationMembership.update({ where: { id: target.id }, data: { status: 'inactive' } });
    });
    response.status(204).end();
  });

  app.post('/api/v1/organizations/:organizationId/ownership-transfer', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const { membership_id: membershipId } = parse(transferInput, request.body);
    const transferred = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await owner(tx, request.user, organizationId);
      const target = await tx.organizationMembership.findFirst({ where: { id: membershipId, organizationId } });
      if (!target) throw notFound('Membership not found');
      if (target.userId === request.user.id || target.status !== 'active' || target.role === 'student')
        throw conflict('Ownership requires another active staff member');
      const user = await tx.user.findUnique({ where: { id: target.userId } });
      if (!user || user.accountType !== 'coordinator' || user.status !== 'active')
        throw conflict('Ownership requires an active coordinator account');
      const current = await tx.organizationMembership.findFirst({
        where: { organizationId, userId: request.user.id, role: 'owner', status: 'active' },
      });
      await tx.organizationMembership.update({ where: { id: current.id }, data: { role: 'coordinator' } });
      await tx.organizationMembership.update({ where: { id: target.id }, data: { role: 'owner' } });
      return { organization_id: organizationId, owner_user_id: target.userId };
    });
    response.set('Cache-Control', 'no-store').json(transferred);
  });

  app.get('/api/v1/organizations/:organizationId/invitations', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    await owner(prisma, request.user, organizationId);
    const invitations = await prisma.organizationInvitation.findMany({ where: { organizationId } });
    response.set('Cache-Control', 'no-store').json(sorted(invitations).map(invitationOut));
  });

  app.post('/api/v1/organizations/:organizationId/invitations', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const data = parse(invitationInput, request.body);
    const code = randomBytes(32).toString('base64url');
    const invitation = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await owner(tx, request.user, organizationId);
      const recipient = await tx.user.findFirst({ where: { primaryEmail: data.email } });
      if (recipient) {
        const membership = await tx.organizationMembership.findFirst({
          where: { organizationId, userId: recipient.id },
        });
        if (membership) throw conflict('This account already has an organization membership');
      }
      const existing = await tx.organizationInvitation.findFirst({ where: { organizationId, email: data.email } });
      const values = {
        role: data.role, status: 'pending', tokenHash: codeDigest(code),
        expiresAt: new Date(Date.now() + invitationDurationMs),
        acceptedAt: null, acceptedBy: null, revokedAt: null,
      };
      return existing
        ? tx.organizationInvitation.update({ where: { id: existing.id }, data: values })
        : tx.organizationInvitation.create({ data: {
            organizationId, email: data.email, createdBy: request.user.id, ...values,
          } });
    });
    response.set('Cache-Control', 'no-store').status(201).json({ ...invitationOut(invitation), code });
  });

  app.delete('/api/v1/organizations/:organizationId/invitations/:invitationId', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const invitationId = uuidParam(request, 'invitationId');
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await owner(tx, request.user, organizationId);
      const invitation = await tx.organizationInvitation.findFirst({ where: { id: invitationId, organizationId } });
      if (!invitation) throw notFound('Invitation not found');
      if (invitation.status === 'pending') await tx.organizationInvitation.update({
        where: { id: invitation.id }, data: { status: 'revoked', revokedAt: new Date() },
      });
    });
    response.status(204).end();
  });

  app.post('/api/v1/organization-invitations/accept', requireUser, async (request, response) => {
    const { code } = parse(acceptInvitationInput, request.body);
    coordinator(request.user);
    const invitation = await prisma.organizationInvitation.findFirst({ where: { tokenHash: codeDigest(code) } });
    if (!invitation) throw notFound('Invitation not found');
    const result = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, invitation.organizationId);
      const current = await tx.organizationInvitation.findFirst({ where: { id: invitation.id } });
      if (!current || current.tokenHash !== codeDigest(code) || current.status !== 'pending' || current.expiresAt <= new Date())
        throw notFound('Invitation not found');
      const organization = await tx.organization.findUnique({ where: { id: current.organizationId } });
      if (!organization || organization.status !== 'active') throw notFound('Invitation not found');
      const user = await tx.user.findUnique({ where: { id: request.user.id } });
      if (!user || user.status !== 'active' || user.accountType !== 'coordinator' || !user.emailVerifiedAt ||
          user.primaryEmail?.trim().toLowerCase() !== current.email)
        throw forbidden('A verified invitation email is required');
      const membership = await tx.organizationMembership.findFirst({
        where: { organizationId: current.organizationId, userId: user.id },
      });
      if (membership) throw conflict('This account already has an organization membership');
      await tx.organizationMembership.create({
        data: { organizationId: current.organizationId, userId: user.id, role: current.role },
      });
      await tx.organizationInvitation.update({ where: { id: current.id }, data: {
        status: 'accepted', acceptedAt: new Date(), acceptedBy: user.id,
      } });
      return { organization_id: organization.id, organization_name: organization.name, role: current.role };
    });
    response.set('Cache-Control', 'no-store').json(result);
  });

  app.post('/api/v1/organizations/:organizationId/cohorts', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    const data = parse(cohortInput, request.body);
    const inviteCode = randomBytes(32).toString('base64url');
    const inviteCodeExpiresAt = new Date(Date.now() + cohortJoinCodeDurationMs);
    const cohort = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await learningStaff(tx, request.user, organizationId);
      await tx.$queryRaw`SELECT id FROM roadmap_versions WHERE id = ${data.roadmap_version_id}::uuid FOR UPDATE`;
      const { version } = await requirePublishedRoadmapVersion(tx, organizationId, data.roadmap_version_id);
      return tx.cohort.create({
        data: {
          organizationId, roadmapVersionId: version.id, name: data.name, createdBy: request.user.id,
          inviteCodeHash: codeDigest(inviteCode), inviteCodeExpiresAt, inviteCodeRevokedAt: null,
        },
      });
    });
    response.set('Cache-Control', 'no-store').status(201).json({
      ...await cohortOut(prisma, cohort), invite_code: inviteCode,
    });
  });

  app.get('/api/v1/organizations/:organizationId/cohorts', requireUser, async (request, response) => {
    const organizationId = uuidParam(request, 'organizationId');
    await learningStaff(prisma, request.user, organizationId);
    const cohorts = sorted(await prisma.cohort.findMany({ where: { organizationId, status: 'active' } }));
    const output = [];
    for (const cohort of cohorts) {
      try {
        const scope = await requireCohortScope(prisma, cohort.id);
        if (scope.organization.id !== organizationId) continue;
        output.push(await cohortOut(prisma, cohort));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    response.json(output);
  });

  app.post('/api/v1/cohorts/join', requireUser, async (request, response) => {
    const data = parse(joinInput, request.body);
    student(request.user);
    await enforceCohortJoinRateLimit(redisClient, request, response, request.user);
    const digest = codeDigest(data.invite_code.trim());
    const cohort = await prisma.cohort.findFirst({ where: {
      inviteCodeHash: digest, status: 'active', inviteCodeRevokedAt: null,
      inviteCodeExpiresAt: { gt: new Date() },
    } });
    if (!cohort) throw notFound('Cohort invite not found');
    const initialScope = await requireCohortScope(prisma, cohort.id);
    const organization = initialScope.organization;
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohort.id}::uuid FOR UPDATE`;
      const currentScope = await requireCohortScope(tx, cohort.id);
      if (currentScope.organization.id !== organization.id) throw notFound('Cohort invite not found');
      const currentCohort = currentScope.cohort;
      if (currentCohort.inviteCodeHash !== digest || currentCohort.inviteCodeRevokedAt ||
          !currentCohort.inviteCodeExpiresAt || currentCohort.inviteCodeExpiresAt <= new Date())
        throw notFound('Cohort invite not found');
      const existing = await tx.organizationMembership.findFirst({
        where: { organizationId: organization.id, userId: request.user.id },
      });
      if (existing && (existing.status !== 'active' || existing.role !== 'student'))
        throw forbidden('Active student membership required');
      await tx.organizationMembership.createMany({
        data: [{ organizationId: organization.id, userId: request.user.id, role: 'student' }], skipDuplicates: true,
      });
      const enrollment = await tx.cohortEnrollment.findUnique({
        where: { cohortId_userId: { cohortId: cohort.id, userId: request.user.id } },
      });
      if (!enrollment) {
        await tx.cohortEnrollment.create({ data: { cohortId: cohort.id, userId: request.user.id } });
      } else if (enrollment.status === 'inactive') {
        if (enrollment.endReason !== 'student_withdrew')
          throw conflict('Enrollment requires staff reinstatement');
        await tx.cohortEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'active', joinedAt: new Date(), endedAt: null, endedBy: null, endReason: null },
        });
      }
      await requireCohortAccess(tx, request.user, cohort.id, { allowStudent: true });
    });
    response.json({ cohort_id: cohort.id, cohort_name: cohort.name, organization_name: organization.name });
  });

  app.post('/api/v1/cohorts/:cohortId/join-code/rotate', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const initial = await requireCohortAccess(prisma, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
    const inviteCode = randomBytes(32).toString('base64url');
    const inviteCodeExpiresAt = new Date(Date.now() + cohortJoinCodeDurationMs);
    const cohort = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, initial.organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohortId}::uuid FOR UPDATE`;
      const current = await requireCohortAccess(tx, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
      if (current.organization.id !== initial.organization.id) throw notFound('Cohort not found');
      return tx.cohort.update({ where: { id: cohortId }, data: {
        inviteCodeHash: codeDigest(inviteCode), inviteCodeExpiresAt, inviteCodeRevokedAt: null,
      } });
    });
    response.set('Cache-Control', 'no-store').json({
      ...await cohortOut(prisma, cohort), invite_code: inviteCode,
    });
  });

  app.delete('/api/v1/cohorts/:cohortId/join-code', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const initial = await requireCohortAccess(prisma, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, initial.organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohortId}::uuid FOR UPDATE`;
      const current = await requireCohortAccess(tx, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
      if (current.organization.id !== initial.organization.id) throw notFound('Cohort not found');
      if (current.cohort.inviteCodeHash || !current.cohort.inviteCodeRevokedAt) {
        await tx.cohort.update({ where: { id: cohortId }, data: {
          inviteCodeHash: null, inviteCodeExpiresAt: null, inviteCodeRevokedAt: new Date(),
        } });
      }
    });
    response.status(204).end();
  });

  app.get('/api/v1/cohorts/:cohortId/enrollments', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const { cohort } = await requireCohortAccess(prisma, request.user, cohortId, {
      staffRoles: LEARNING_RESOURCE_ROLES,
    });
    const enrollments = sorted(await prisma.cohortEnrollment.findMany({ where: { cohortId } }), 'joinedAt');
    const userIds = enrollments.map((row) => row.userId);
    const memberships = userIds.length ? await prisma.organizationMembership.findMany({ where: {
      organizationId: cohort.organizationId, userId: { in: userIds }, role: 'student',
    } }) : [];
    const allowedUsers = new Set(memberships.map((row) => row.userId));
    const users = allowedUsers.size ? await prisma.user.findMany({ where: {
      id: { in: [...allowedUsers] }, accountType: 'student', status: 'active',
    } }) : [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    response.set('Cache-Control', 'no-store').json(enrollments.flatMap((enrollment) => {
      const user = usersById.get(enrollment.userId);
      if (!user) return [];
      return [{
        id: enrollment.id, user_id: user.id, display_name: user.displayName,
        status: enrollment.status, joined_at: enrollment.joinedAt,
        ended_at: enrollment.endedAt, end_reason: enrollment.endReason,
      }];
    }));
  });

  app.delete('/api/v1/cohorts/:cohortId/enrollments/me', requireUser, async (request, response) => {
    student(request.user);
    const cohortId = uuidParam(request, 'cohortId');
    const initial = await requireCohortScope(prisma, cohortId);
    await requireOrganizationRole(prisma, request.user, initial.organization.id, ['student']);
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, initial.organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohortId}::uuid FOR UPDATE`;
      const current = await requireCohortScope(tx, cohortId);
      await requireOrganizationRole(tx, request.user, current.organization.id, ['student']);
      const enrollment = await tx.cohortEnrollment.findUnique({
        where: { cohortId_userId: { cohortId, userId: request.user.id } },
      });
      if (!enrollment) throw notFound('Cohort enrollment not found');
      if (enrollment.status === 'inactive') {
        if (enrollment.endReason !== 'student_withdrew')
          throw conflict('Enrollment was ended by staff and cannot be withdrawn by the student');
        return;
      }
      await tx.cohortEnrollment.update({ where: { id: enrollment.id }, data: {
        status: 'inactive', endedAt: new Date(), endedBy: request.user.id, endReason: 'student_withdrew',
      } });
    });
    response.status(204).end();
  });

  app.delete('/api/v1/cohorts/:cohortId/enrollments/:enrollmentId', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const enrollmentId = uuidParam(request, 'enrollmentId');
    const initial = await requireCohortAccess(prisma, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
    await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, initial.organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohortId}::uuid FOR UPDATE`;
      const current = await requireCohortAccess(tx, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
      if (current.organization.id !== initial.organization.id) throw notFound('Cohort not found');
      const enrollment = await tx.cohortEnrollment.findFirst({ where: { id: enrollmentId, cohortId } });
      if (!enrollment) throw notFound('Cohort enrollment not found');
      if (enrollment.status !== 'inactive') {
        await tx.cohortEnrollment.update({ where: { id: enrollment.id }, data: {
          status: 'inactive', endedAt: new Date(), endedBy: request.user.id, endReason: 'staff_removed',
        } });
      }
    });
    response.status(204).end();
  });

  app.post('/api/v1/cohorts/:cohortId/enrollments/:enrollmentId/reactivate', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const enrollmentId = uuidParam(request, 'enrollmentId');
    const initial = await requireCohortAccess(prisma, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
    const enrollment = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, initial.organization.id);
      await tx.$queryRaw`SELECT id FROM cohorts WHERE id = ${cohortId}::uuid FOR UPDATE`;
      const current = await requireCohortAccess(tx, request.user, cohortId, { staffRoles: LEARNING_RESOURCE_ROLES });
      if (current.organization.id !== initial.organization.id) throw notFound('Cohort not found');
      const existing = await tx.cohortEnrollment.findFirst({ where: { id: enrollmentId, cohortId } });
      if (!existing) throw notFound('Cohort enrollment not found');
      if (existing.status === 'active') return existing;
      return tx.cohortEnrollment.update({ where: { id: existing.id }, data: {
        status: 'active', joinedAt: new Date(), endedAt: null, endedBy: null, endReason: null,
      } });
    });
    response.set('Cache-Control', 'no-store').json({ id: enrollment.id, status: enrollment.status });
  });

  app.get('/api/v1/progress/me', requireUser, async (request, response) => {
    student(request.user);
    response.set('Cache-Control', 'no-store');
    const enrollments = await prisma.cohortEnrollment.findMany({ where: { userId: request.user.id, status: 'active' } });
    const result = [];
    for (const enrollment of sorted(enrollments, 'joinedAt')) {
      let scope;
      try {
        scope = await requireCohortAccess(prisma, request.user, enrollment.cohortId, { allowStudent: true });
      } catch (error) {
        if (error.status === 403 || error.status === 404) continue;
        throw error;
      }
      const { cohort, organization, version, roadmap } = scope;
      const phases = await roadmapTree(prisma, version.id);
      const list = flattenRoadmapTree(phases);
      const progress = list.length
        ? await prisma.topicProgress.findMany({ where: { userId: request.user.id, topicId: { in: list.map((topic) => topic.id) } } })
        : [];
      const byTopic = new Map(progress.map((row) => [row.topicId, row]));
      const addProgress = (topic) => ({
        ...topic, completed: byTopic.has(topic.id),
        completed_at: byTopic.get(topic.id)?.updatedAt ?? null,
      });
      const topicOutput = list.map(addProgress);
      const phaseOutput = phases.map((phase) => ({
        ...phase, weeks: phase.weeks.map((week) => ({
          ...week, topics: week.topics.map(addProgress),
        })),
      }));
      result.push({
        cohort_id: cohort.id, cohort_name: cohort.name, organization_name: organization.name,
        roadmap_name: roadmap.name, roadmap_version_id: version.id, roadmap_version_number: version.versionNumber,
        completed: progress.length, total: list.length, percent: percent(progress.length, list.length),
        topics: topicOutput, phases: phaseOutput,
      });
    }
    response.json(result);
  });

  app.put('/api/v1/progress/topics/:topicId', requireUser, async (request, response) => {
    const topicId = uuidParam(request, 'topicId');
    const data = parse(progressInput, request.body);
    student(request.user);
    await prisma.$transaction(async (tx) => {
      const initialScope = await requireAssignedTopicAccess(tx, request.user, topicId);
      await lockOrganization(tx, initialScope.organization.id);
      const authorizedScope = await requireAssignedTopicAccess(tx, request.user, topicId);
      if (authorizedScope.organization.id !== initialScope.organization.id)
        throw notFound('Assigned topic not found');
      const { topic, organization } = authorizedScope;
      const previous = await tx.topicProgress.findFirst({ where: { userId: request.user.id, topicId: topic.id } });
      if (Boolean(previous?.status === 'completed') === data.completed) return;
      if (data.completed) {
        await tx.topicProgress.upsert({
          where: { userId_topicId: { userId: request.user.id, topicId: topic.id } },
          create: { userId: request.user.id, topicId: topic.id, status: 'completed' },
          update: { status: 'completed', updatedAt: new Date() },
        });
      } else {
        await tx.topicProgress.deleteMany({ where: { userId: request.user.id, topicId: topic.id } });
      }
      await tx.activityEvent.create({ data: {
        organizationId: organization.id, userId: request.user.id, topicId: topic.id,
        eventType: data.completed ? 'topic_completed' : 'topic_reopened',
        oldStatus: data.completed ? 'not_started' : 'completed',
        newStatus: data.completed ? 'completed' : 'not_started',
      } });
    });
    response.set('Cache-Control', 'no-store').status(204).end();
  });

  app.get('/api/v1/cohorts/:cohortId/progress', requireUser, async (request, response) => {
    const cohortId = uuidParam(request, 'cohortId');
    const { cohort, version, roadmap } = await requireCohortAccess(prisma, request.user, cohortId, {
      staffRoles: LEARNING_RESOURCE_ROLES,
    });
    response.set('Cache-Control', 'no-store');
    const list = await topics(prisma, cohort.roadmapVersionId);
    const eligibleIds = await eligibleStudentIds(prisma, cohort);
    const users = eligibleIds.length
      ? await prisma.user.findMany({ where: {
          id: { in: eligibleIds }, status: 'active', accountType: 'student',
        } })
      : [];
    users.sort((a, b) => a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const where = {
          userId: { in: users.map((user) => user.id) },
          topicId: { in: list.map((topic) => topic.id) },
          status: 'completed',
    };
    const [byUser, byTopic] = users.length && list.length
      ? await Promise.all([
          prisma.topicProgress.groupBy({ by: ['userId'], where, _count: { _all: true } }),
          prisma.topicProgress.groupBy({ by: ['topicId'], where, _count: { _all: true } }),
        ]) : [[], []];
    const userCounts = new Map(byUser.map((row) => [row.userId, row._count._all]));
    const topicCounts = new Map(byTopic.map((row) => [row.topicId, row._count._all]));
    const completed = byUser.reduce((sum, row) => sum + row._count._all, 0);
    const possible = users.length * list.length;
    const average = percent(completed, possible);
    const students = users.map((user) => {
      const count = userCounts.get(user.id) ?? 0;
      return { id: user.id, name: user.displayName, completed: count, total: list.length, percent: percent(count, list.length), below_average: possible > 0 && count * users.length < completed };
    });
    const topicStats = list.map((topic) => {
      const count = topicCounts.get(topic.id) ?? 0;
      return { id: topic.id, title: topic.title, completed: count, total: users.length, percent: percent(count, users.length) };
    });
    response.json({
      cohort_id: cohort.id, cohort_name: cohort.name, roadmap_name: roadmap?.name ?? 'Roadmap',
      roadmap_version_id: version.id, roadmap_version_number: version.versionNumber,
      students, topics: topicStats,
      average_percent: average, time_scope: 'all_time_current_completion',
      metrics: { eligible_students: users.length, topics: list.length, completed_topic_assignments: completed, possible_topic_assignments: possible },
    });
  });
  registerActivityRoutes(app, { prisma, requireUser });
}
