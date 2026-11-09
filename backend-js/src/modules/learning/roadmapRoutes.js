import { z } from 'zod';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { LEARNING_RESOURCE_ROLES, requireOrganizationRole } from '../../core/authorization.js';

const uuid = z.string().uuid();
const title = z.string().trim().min(2).max(200);
const topicInput = z.strictObject({ title, description: z.string().trim().max(1000).default('') });
const roadmapInput = z.strictObject({
  name: title, description: z.string().trim().max(2000).default(''),
  topics: z.array(topicInput).min(1).max(24),
});
const hierarchyInput = z.strictObject({ phases: z.array(z.strictObject({
  title,
  weeks: z.array(z.strictObject({
    title,
    topics: z.array(topicInput).max(24),
  })).max(52),
})).max(12) }).refine((value) =>
  value.phases.reduce((count, phase) => count + phase.weeks.reduce((sum, week) => sum + week.topics.length, 0), 0) <= 500,
{ message: 'A draft can contain at most 500 topics' });
const copyInput = z.strictObject({ source_version_id: uuid });

function parse(schema, value, location = 'body') {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(422, 'validation_error', 'Request validation failed',
    result.error.issues.map((issue) => ({ loc: [location, ...issue.path], type: issue.code })));
}
const param = (request, name) => parse(uuid, request.params[name], 'path');
const staff = (prisma, user, organizationId) =>
  requireOrganizationRole(prisma, user, organizationId, LEARNING_RESOURCE_ROLES);
const publisher = (prisma, user, organizationId) =>
  requireOrganizationRole(prisma, user, organizationId, ['owner', 'admin']);

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
  return {
    id: roadmap.id, organization_id: roadmap.organizationId, name: roadmap.name,
    description: roadmap.description, version_id: version.id, version_number: version.versionNumber,
    status: version.status, created_at: version.createdAt, published_at: version.publishedAt,
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
    await staff(prisma, request.user, organizationId);
    const { roadmap, version } = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await staff(tx, request.user, organizationId);
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
      return { roadmap, version };
    }, { timeout: 30_000 });
    response.status(201).json(await output(prisma, roadmap, version));
  });

  app.get(base, requireUser, async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request.user, organizationId);
    const roadmaps = await prisma.roadmap.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
    const result = [];
    for (const roadmap of roadmaps) {
      const rows = await prisma.roadmapVersion.findMany({
        where: { roadmapId: roadmap.id }, orderBy: { versionNumber: 'asc' },
      });
      for (const version of rows) result.push(await output(prisma, roadmap, version));
    }
    response.json(result);
  });

  const listVersions = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    await staff(prisma, request.user, organizationId);
    const { roadmap } = await scope(prisma, organizationId, roadmapId);
    const rows = await prisma.roadmapVersion.findMany({
      where: { roadmapId }, orderBy: { versionNumber: 'asc' },
    });
    response.json(await Promise.all(rows.map((version) => output(prisma, roadmap, version))));
  };
  app.get(versions, requireUser, listVersions);

  const getVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request.user, organizationId);
    const { roadmap, version } = await scope(prisma, organizationId,
      param(request, 'roadmapId'), param(request, 'versionId'));
    response.json(await output(prisma, roadmap, version));
  };
  app.get(versionPath, requireUser, getVersion);

  const copyVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const { source_version_id: sourceId } = parse(copyInput, request.body);
    await staff(prisma, request.user, organizationId);
    const result = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await lockRoadmap(tx, roadmapId);
      await staff(tx, request.user, organizationId);
      const { roadmap, version: source } = await scope(tx, organizationId, roadmapId, sourceId);
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
      return { roadmap, version };
    }, { timeout: 30_000 });
    response.status(201).json(await output(prisma, result.roadmap, result.version));
  };
  app.post(versions, requireUser, copyVersion);

  const replaceDraft = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const versionId = param(request, 'versionId');
    const data = parse(hierarchyInput, request.body);
    await staff(prisma, request.user, organizationId);
    const result = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await lockVersion(tx, versionId);
      await staff(tx, request.user, organizationId);
      const { roadmap, version } = await scope(tx, organizationId, roadmapId, versionId);
      if (version.status !== 'draft') throw conflict('Only draft versions can be edited');
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
      return { roadmap, version };
    }, { timeout: 30_000 });
    response.json(await output(prisma, result.roadmap, result.version));
  };
  app.put(versionPath, requireUser, replaceDraft);

  const publishVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const versionId = param(request, 'versionId');
    await publisher(prisma, request.user, organizationId);
    const result = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await lockVersion(tx, versionId);
      await publisher(tx, request.user, organizationId);
      const { roadmap, version } = await scope(tx, organizationId, roadmapId, versionId);
      if (version.status !== 'draft') throw conflict('Only draft versions can be published');
      if (!complete(await hierarchy(tx, versionId))) {
        throw new AppError(422, 'incomplete_roadmap', 'Every phase needs a week and every week needs a topic');
      }
      const published = await tx.roadmapVersion.update({ where: { id: versionId }, data: {
        status: 'published', publishedAt: new Date(),
      } });
      return { roadmap, version: published };
    });
    response.json(await output(prisma, result.roadmap, result.version));
  };
  app.post(`${versionPath}/publish`, requireUser, publishVersion);

  const archiveVersion = async (request, response) => {
    const organizationId = param(request, 'organizationId');
    const roadmapId = param(request, 'roadmapId');
    const versionId = param(request, 'versionId');
    await staff(prisma, request.user, organizationId);
    const result = await prisma.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await lockVersion(tx, versionId);
      await staff(tx, request.user, organizationId);
      const { roadmap, version } = await scope(tx, organizationId, roadmapId, versionId);
      if (version.status !== 'published') throw conflict('Only published versions can be archived');
      const archived = await tx.roadmapVersion.update({ where: { id: versionId }, data: { status: 'archived' } });
      return { roadmap, version: archived };
    });
    response.json(await output(prisma, result.roadmap, result.version));
  };
  app.post(`${versionPath}/archive`, requireUser, archiveVersion);

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
  app.post(`${canonicalVersion}/publish`, requireUser, inferVersion, publishVersion);
  app.post(`${canonicalVersion}/archive`, requireUser, inferVersion, archiveVersion);
  app.get('/api/v1/roadmaps/:roadmapId', requireUser, inferRoadmap, async (request, response) => {
    const organizationId = param(request, 'organizationId');
    await staff(prisma, request.user, organizationId);
    const { roadmap } = await scope(prisma, organizationId, param(request, 'roadmapId'));
    response.json({ id: roadmap.id, organization_id: organizationId,
      name: roadmap.name, description: roadmap.description });
  });
}
