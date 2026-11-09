import { z } from 'zod';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { assertRevision, authorizeRoadmap, decideVersion, lifecycleAudit, roadmapTransaction,
  reviewOutput, reviewSelect, submitVersion } from './roadmapWorkflow.js';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
const revisionInput = z.strictObject({ revision });
const decisionInput = z.strictObject({ revision, submission_id: uuid });
const rejectionInput = decisionInput.extend({ reason: z.string().trim().min(1).max(2000) });
const historyQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0) });
const title = z.string().trim().min(2).max(200);
const topicInput = z.strictObject({ title, description: z.string().trim().max(1000).default('') });
const roadmapInput = z.strictObject({
  name: title, description: z.string().trim().max(2000).default(''),
  topics: z.array(topicInput).min(1).max(24),
});
const hierarchyInput = z.strictObject({ revision, phases: z.array(z.strictObject({
  title,
  weeks: z.array(z.strictObject({
    title,
    topics: z.array(topicInput).max(24),
  })).max(52),
})).max(12) }).refine((value) =>
  value.phases.reduce((count, phase) => count + phase.weeks.reduce((sum, week) => sum + week.topics.length, 0), 0) <= 500,
{ message: 'A draft can contain at most 500 topics' });
const copyInput = z.strictObject({ source_version_id: uuid, revision });

function parse(schema, value, location = 'body') {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(422, 'validation_error', 'Request validation failed',
    result.error.issues.map((issue) => ({ loc: [location, ...issue.path], type: issue.code })));
}
const param = (request, name) => parse(uuid, request.params[name], 'path');
const staff = (prisma, request, organizationId, action = 'reviews', lock = false) =>
  authorizeRoadmap(prisma, request, organizationId, action, lock);

async function scope(prisma, organizationId, roadmapId, versionId) {
  const roadmap = await prisma.roadmap.findUnique({ where: { id: roadmapId } });
  if (!roadmap || roadmap.organizationId !== organizationId) throw notFound('Roadmap not found');
  if (!versionId) return { roadmap };
  const version = await prisma.roadmapVersion.findUnique({ where: { id: versionId } });
  if (!version || version.roadmapId !== roadmap.id) throw notFound('Roadmap version not found');
  return { roadmap, version };
}

async function hierarchy(prisma, versionId) {
  const phases = await prisma.phase.findMany({ where: { roadmapVersionId: versionId }, orderBy: { orderIndex: 'asc' } });
  const weeks = phases.length ? await prisma.week.findMany({
    where: { phaseId: { in: phases.map((row) => row.id) } }, orderBy: { orderIndex: 'asc' },
  }) : [];
  const topics = weeks.length ? await prisma.topic.findMany({
    where: { weekId: { in: weeks.map((row) => row.id) } }, orderBy: { orderIndex: 'asc' },
  }) : [];
  return phases.map((phase) => ({
    id: phase.id, title: phase.title, order_index: phase.orderIndex,
    weeks: weeks.filter((week) => week.phaseId === phase.id).map((week) => ({
      id: week.id, title: week.title, order_index: week.orderIndex,
      topics: topics.filter((topic) => topic.weekId === week.id).map((topic) => ({
        id: topic.id, title: topic.title, description: topic.description, order_index: topic.orderIndex,
        week: week.orderIndex,
      })),
    })),
  }));
}

async function output(prisma, roadmap, version) {
  const phases = await hierarchy(prisma, version.id);
  const pending = await prisma.roadmapReviewAttempt.findFirst({
    where: { versionId: version.id, decision: 'pending' }, select: reviewSelect,
  });
  return {
    id: roadmap.id, organization_id: roadmap.organizationId, name: roadmap.name,
    description: roadmap.description, version_id: version.id, version_number: version.versionNumber,
    status: version.status, revision: version.revision, pending_submission: reviewOutput(pending),
    created_at: version.createdAt, published_at: version.publishedAt,
    phases, topics: phases.flatMap((phase) => phase.weeks.flatMap((week) => week.topics)),
  };
}

async function writeHierarchy(tx, versionId, phases) {
  for (const [phaseIndex, entry] of phases.entries()) {
    const phase = await tx.phase.create({ data: {
      roadmapVersionId: versionId, title: entry.title, orderIndex: phaseIndex + 1,
    } });
    for (const [weekIndex, weekEntry] of entry.weeks.entries()) {
      const week = await tx.week.create({ data: {
        phaseId: phase.id, title: weekEntry.title, orderIndex: weekIndex + 1,
      } });
      for (const [topicIndex, topic] of weekEntry.topics.entries()) {
        await tx.topic.create({ data: {
          weekId: week.id, title: topic.title, description: topic.description,
          orderIndex: topicIndex + 1,
        } });
      }
    }
  }
}

async function lockVersion(tx, versionId) {
  await tx.$queryRaw`SELECT id FROM roadmap_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
}
async function lockRoadmap(tx, roadmapId) {
  await tx.$queryRaw`SELECT id FROM roadmaps WHERE id = ${roadmapId}::uuid FOR UPDATE`;
}
async function lockOrganization(tx, organizationId) {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
}
function complete(phases) {
  return phases.length > 0 && phases.every((phase) =>
    phase.title.trim() && phase.weeks.length > 0 && phase.weeks.every((week) =>
      week.title.trim() && week.topics.length > 0 && week.topics.every((topic) => topic.title.trim())));
}

export function registerRoadmapRoutes(app, { prisma, requireUser }) {
  const base = '/api/v1/organizations/:organizationId/roadmaps';
  const versions = `${base}/:roadmapId/versions`;
  const versionPath = `${versions}/:versionId`;

  app.post(base, requireUser, async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const data = parse(roadmapInput, request.body);
    await staff(prisma, request, organizationId, 'create');
    const result = await roadmapTransaction(prisma, request, async (tx) => {
      await lockOrganization(tx, organizationId);
      await staff(tx, request, organizationId, 'create', true);
      const roadmap = await tx.roadmap.create({ data: {
        organizationId, name: data.name, description: data.description, createdBy: request.user.id,
      } });
      const version = await tx.roadmapVersion.create({ data: {
        roadmapId: roadmap.id, versionNumber: 1, status: 'draft', createdBy: request.user.id,
      } });
      await writeHierarchy(tx, version.id, [{
        title: 'Learning path', weeks: data.topics.map((topic, index) => ({
          title: `Week ${index + 1}`, topics: [topic],
        })),
      }]);
      return output(tx, roadmap, version);
    });
    response.status(201).json(result);
  });

  app.get(base, requireUser, async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request, organizationId);
    const result = await roadmapTransaction(prisma, request, async tx => {
      await staff(tx, request, organizationId);
      const roadmaps = await tx.roadmap.findMany({ where: { organizationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const rows = [];
      for (const roadmap of roadmaps) {
        const versions = await tx.roadmapVersion.findMany({ where: { roadmapId: roadmap.id }, orderBy: { versionNumber: 'asc' } });
        for (const version of versions) rows.push(await output(tx, roadmap, version));
      }
      return rows;
    }, { isolationLevel: 'RepeatableRead' });
    response.json(result);
  });

  const listVersions = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    await staff(prisma, request, organizationId);
    const result = await roadmapTransaction(prisma, request, async tx => {
      await staff(tx, request, organizationId);
      const { roadmap } = await scope(tx, organizationId, roadmapId);
      const rows = await tx.roadmapVersion.findMany({ where: { roadmapId }, orderBy: { versionNumber: 'asc' } });
      return Promise.all(rows.map(version => output(tx, roadmap, version)));
    }, { isolationLevel: 'RepeatableRead' });
    response.json(result);
  };
  app.get(versions, requireUser, listVersions);

  const getVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request, organizationId);
    const result = await roadmapTransaction(prisma, request, async tx => {
      await staff(tx, request, organizationId);
      const { roadmap, version } = await scope(tx, organizationId, param(request, 'roadmapId'), param(request, 'versionId'));
      return output(tx, roadmap, version);
    }, { isolationLevel: 'RepeatableRead' });
    response.json(result);
  };
  app.get(versionPath, requireUser, getVersion);

  const copyVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    await staff(prisma, request, organizationId, 'copy');
    const { source_version_id: sourceId, revision: expectedRevision } = parse(copyInput, request.body);
    const result = await roadmapTransaction(prisma, request, async (tx) => {
      await lockOrganization(tx, organizationId);
      await staff(tx, request, organizationId, 'copy', true);
      await lockRoadmap(tx, roadmapId);
      await lockVersion(tx, sourceId);
      const { roadmap, version: source } = await scope(tx, organizationId, roadmapId, sourceId);
      await staff(tx, request, organizationId, 'copy');
      assertRevision(source, expectedRevision);
      if (!['published', 'archived'].includes(source.status)) {
        throw conflict('Publish a version before copying it to a new draft');
      }
      const rows = await tx.roadmapVersion.findMany({ where: { roadmapId }, orderBy: { versionNumber: 'desc' } });
      const version = await tx.roadmapVersion.create({ data: {
        roadmapId, versionNumber: (rows[0]?.versionNumber ?? 0) + 1,
        status: 'draft', createdBy: request.user.id,
      } });
      const original = await hierarchy(tx, source.id);
      await writeHierarchy(tx, version.id, original.map((phase) => ({
        title: phase.title, weeks: phase.weeks.map((week) => ({
          title: week.title, topics: week.topics.map((topic) => ({
            title: topic.title, description: topic.description,
          })),
        })),
      })));
      return output(tx, roadmap, version);
    });
    response.status(201).json(result);
  };
  app.post(versions, requireUser, copyVersion);

  const replaceDraft = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const versionId = param(request, 'versionId');
    await staff(prisma, request, organizationId, 'edit');
    const data = parse(hierarchyInput, request.body);
    const result = await roadmapTransaction(prisma, request, async (tx) => {
      await lockOrganization(tx, organizationId);
      await staff(tx, request, organizationId, 'edit', true);
      await lockVersion(tx, versionId);
      const { roadmap, version } = await scope(tx, organizationId, roadmapId, versionId);
      await staff(tx, request, organizationId, 'edit');
      if (version.status !== 'draft') throw conflict('Only draft versions can be edited');
      assertRevision(version, data.revision);
      const currentPhases = await tx.phase.findMany({ where: { roadmapVersionId: version.id } });
      const currentWeeks = currentPhases.length ? await tx.week.findMany({
        where: { phaseId: { in: currentPhases.map((phase) => phase.id) } },
      }) : [];
      if (currentWeeks.length) await tx.topic.deleteMany({
        where: { weekId: { in: currentWeeks.map((week) => week.id) } },
      });
      if (currentPhases.length) await tx.week.deleteMany({
        where: { phaseId: { in: currentPhases.map((phase) => phase.id) } },
      });
      await tx.phase.deleteMany({ where: { roadmapVersionId: version.id } });
      await writeHierarchy(tx, version.id, data.phases);
      return output(tx, roadmap, await tx.roadmapVersion.findUnique({ where: { id: versionId } }));
    });
    response.json(result);
  };
  app.put(versionPath, requireUser, replaceDraft);

  // All lifecycle actions, including publication aliases, share this path.
  const lifecycle = action => async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const versionId = param(request, 'versionId');
    // Authorization and ancestry precede body validation, preserving AC01 denials.
    await staff(prisma, request, organizationId, action);
    await scope(prisma, organizationId, roadmapId, versionId);
    const input = parse(action === 'reject' ? rejectionInput
      : action === 'approve' ? decisionInput : revisionInput, request.body);
    const result = await roadmapTransaction(prisma, request, async tx => {
      await lockOrganization(tx, organizationId);
      await staff(tx, request, organizationId, action, true);
      await lockVersion(tx, versionId);
      const { roadmap, version } = await scope(tx, organizationId, roadmapId, versionId);
      // Session expiry can advance while waiting for a resource lock.
      await staff(tx, request, organizationId, action);
      let updated;
      if (action === 'submit') {
        if (version.status !== 'draft') throw conflict('Only draft versions can be submitted');
        assertRevision(version, input.revision);
        if (!complete(await hierarchy(tx, versionId))) {
          throw new AppError(422, 'incomplete_roadmap', 'Every phase needs a week and every week needs a topic');
        }
        updated = await submitVersion(tx, request, roadmap, version, input.revision);
      } else if (action === 'approve' || action === 'reject') {
        updated = await decideVersion(tx, request, roadmap, version, input, action === 'approve' ? 'approved' : 'rejected');
      } else {
        if (version.status !== 'published') throw conflict('Only published versions can be archived');
        assertRevision(version, input.revision);
        updated = await tx.roadmapVersion.update({ where: { id: versionId }, data: { status: 'archived' } });
        await lifecycleAudit(tx, request, roadmap, updated, 'roadmap.archived');
      }
      return output(tx, roadmap, updated);
    });
    response.json(result);
  };
  const submit = lifecycle('submit');
  const approve = lifecycle('approve');
  const reject = lifecycle('reject');
  const archiveVersion = lifecycle('archive');
  app.post(`${versionPath}/submit`, requireUser, submit);
  app.post(`${versionPath}/approve`, requireUser, approve);
  app.post(`${versionPath}/reject`, requireUser, reject);
  app.post(`${versionPath}/publish`, requireUser, approve);
  app.post(`${versionPath}/archive`, requireUser, archiveVersion);

  const reviews = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request, organizationId);
    const { limit, offset } = parse(historyQuery, request.query, 'query');
    const result = await roadmapTransaction(prisma, request, async tx => {
      await staff(tx, request, organizationId);
      const { version } = await scope(tx, organizationId, param(request, 'roadmapId'), param(request, 'versionId'));
      const rows = await tx.roadmapReviewAttempt.findMany({ where: { versionId: version.id },
        orderBy: [{ submittedRevision: 'desc' }, { id: 'desc' }], skip: offset, take: limit + 1, select: reviewSelect });
      const pending = await tx.roadmapReviewAttempt.findFirst({ where: { versionId: version.id, decision: 'pending' }, select: reviewSelect });
      return { version_id: version.id, status: version.status, revision: version.revision,
        pending_submission: reviewOutput(pending), reviews: rows.slice(0, limit).map(reviewOutput),
        pagination: { limit, offset, next_offset: rows.length > limit ? offset + limit : null } };
    }, { isolationLevel: 'RepeatableRead' });
    response.json(result);
  };
  app.get(`${versionPath}/reviews`, requireUser, reviews);

  // Canonical IDs from the build guide resolve their tenant through the
  // persisted parent before the same authorization and parent checks run.
  const inferRoadmap = async (request, _response, next) => {
    const roadmap = await prisma.roadmap.findUnique({ where: { id: param(request, 'roadmapId') } });
    if (!roadmap) throw notFound('Roadmap not found');
    request.params.organizationId = roadmap.organizationId;
    next();
  };
  const inferVersion = async (request, response, next) => {
    const version = await prisma.roadmapVersion.findUnique({ where: { id: param(request, 'versionId') } });
    if (!version) throw notFound('Roadmap version not found');
    request.params.roadmapId = version.roadmapId;
    await inferRoadmap(request, response, next);
  };
  const canonicalVersions = '/api/v1/roadmaps/:roadmapId/versions';
  const canonicalVersion = '/api/v1/roadmap-versions/:versionId';
  app.get(canonicalVersions, requireUser, inferRoadmap, listVersions);
  app.post(canonicalVersions, requireUser, inferRoadmap, copyVersion);
  app.get(canonicalVersion, requireUser, inferVersion, getVersion);
  app.patch(canonicalVersion, requireUser, inferVersion, replaceDraft);
  app.post(`${canonicalVersion}/submit`, requireUser, inferVersion, submit);
  app.post(`${canonicalVersion}/approve`, requireUser, inferVersion, approve);
  app.post(`${canonicalVersion}/reject`, requireUser, inferVersion, reject);
  app.get(`${canonicalVersion}/reviews`, requireUser, inferVersion, reviews);
  app.post(`${canonicalVersion}/publish`, requireUser, inferVersion, approve);
  app.post(`${canonicalVersion}/archive`, requireUser, inferVersion, archiveVersion);
  app.get('/api/v1/roadmaps/:roadmapId', requireUser, inferRoadmap, async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request, organizationId);
    const { roadmap } = await scope(prisma, organizationId, param(request, 'roadmapId'));
    response.json({ id: roadmap.id, organization_id: organizationId,
      name: roadmap.name, description: roadmap.description });
  });
}
