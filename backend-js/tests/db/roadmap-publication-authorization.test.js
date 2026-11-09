import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPrismaClient } from '../../src/db/client.js';
import { issueSession } from '../../src/modules/auth/service.js';
import { removeTestOrganizations } from './cleanup.js';

const databaseUrl = (process.env.OUTPOST_DATABASE_URL || process.env.DATABASE_URL || '')
  .replace(/^postgresql\+psycopg:\/\//, 'postgresql://');
const entryPoints = ['nested', 'canonical'];

function publicationPath(entryPoint, draft, organizationId) {
  return entryPoint === 'canonical'
    ? `/api/v1/roadmap-versions/${draft.version_id}/publish`
    : `/api/v1/organizations/${organizationId}/roadmaps/${draft.id}/versions/${draft.version_id}/publish`;
}

async function withFixture(run) {
  const suffix = randomUUID();
  const connectionUrl = new URL(databaseUrl);
  const applicationName = `ac01-${suffix}`;
  connectionUrl.searchParams.set('application_name', applicationName);
  const prisma = createPrismaClient(connectionUrl.href);
  const users = [];
  const organizations = [];
  const settings = { env: 'test', authSigningKey: randomBytes(48).toString('base64url') };
  const app = createApp({ prisma, settings, emailProvider: { send: async () => {} } });
  try {
    for (const label of ['Campus', 'Other campus']) {
      organizations.push(await prisma.organization.create({ data: {
        name: label, slug: `ac01-${organizations.length}-${suffix}`,
      } }));
    }
    const [organization, foreignOrganization] = organizations;
    const actors = {};
    for (const [name, role, status, organizationId] of [
      ['owner', 'owner', 'active', organization.id],
      ['admin', 'admin', 'active', organization.id],
      ['coordinator', 'coordinator', 'active', organization.id],
      ['mentor', 'mentor', 'active', organization.id],
      ['student', 'student', 'active', organization.id],
      ['inactiveOwner', 'owner', 'inactive', organization.id],
      ['inactiveAdmin', 'admin', 'inactive', organization.id],
      ['foreignOwner', 'owner', 'active', foreignOrganization.id],
      ['foreignAdmin', 'admin', 'active', foreignOrganization.id],
    ]) {
      const user = await prisma.user.create({ data: {
        displayName: `AC01 ${name}`, accountType: role === 'student' ? 'student' : 'coordinator',
      } });
      users.push(user.id);
      const membership = await prisma.organizationMembership.create({ data: {
        organizationId, userId: user.id, role, status,
      } });
      actors[name] = { user, membership };
    }
    async function auth(name) {
      const actor = actors[name];
      if (!actor.access) {
        const session = await issueSession(prisma, settings, actor.user, 'test', { get: () => undefined });
        actor.access = session.access;
      }
      return { Authorization: `Bearer ${actor.access}` };
    }
    async function draft(name = 'coordinator', organizationId = organization.id) {
      const result = await request(app).post(`/api/v1/organizations/${organizationId}/roadmaps`)
        .set(await auth(name)).send({
          name: 'Publication permission fixture',
          topics: [{ title: 'First assigned topic' }, { title: 'Second assigned topic' }],
        });
      expect(result.status).toBe(201);
      expect(result.body.status).toBe('draft');
      return result.body;
    }
    async function snapshot() {
      const versions = await prisma.roadmapVersion.findMany({
        where: { roadmap: { organizationId: { in: organizations.map(row => row.id) } } },
        orderBy: { id: 'asc' },
        include: { phases: {
          orderBy: { id: 'asc' }, include: { weeks: {
            orderBy: { id: 'asc' }, include: { topics: { orderBy: { id: 'asc' } } },
          } },
        } },
      });
      return { versions, publishedCount: versions.filter(row => row.status === 'published').length };
    }
    async function expectDenied(path, name, expectedStatus = 403) {
      const headers = name ? await auth(name) : {};
      const before = await snapshot();
      const result = await request(app).post(path).set(headers);
      const after = await snapshot();
      expect.soft(result.status).toBe(expectedStatus);
      // Includes status, publication time, version count and every hierarchy row.
      expect(after).toEqual(before);
    }
    await run({
      prisma, app, organization, foreignOrganization, actors, auth, draft, snapshot, expectDenied,
      connectionString: connectionUrl.href, applicationName,
    });
  } finally {
    try {
      await removeTestOrganizations(prisma, organizations.map(row => row.id), users);
    } finally { await prisma.$disconnect(); }
  }
}

describe.skipIf(!databaseUrl)('AC01 publication authorization in PostgreSQL', () => {
  for (const entryPoint of entryPoints) {
    test(`AC01 coordinator ${entryPoint} publication is denied without changing the draft`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), 'coordinator');
      });
    }, 30_000);

    for (const role of ['owner', 'admin']) {
      test(`AC01 active ${role} can publish through ${entryPoint} and SQL immutability stays active`, async () => {
        await withFixture(async (f) => {
          const draft = await f.draft();
          const before = await f.snapshot();
          const result = await request(f.app).post(publicationPath(entryPoint, draft, f.organization.id))
            .set(await f.auth(role));
          expect(result.status).toBe(200);
          expect(result.body.status).toBe('published');
          const after = await f.snapshot();
          expect(after.publishedCount).toBe(before.publishedCount + 1);
          expect(after.versions[0]).toMatchObject({ id: draft.version_id, status: 'published' });
          expect(after.versions[0].publishedAt).toBeInstanceOf(Date);
          expect(after.versions[0].publishedAt.toISOString()).toBe(result.body.published_at);
          expect(after.versions[0].phases).toEqual(before.versions[0].phases);
          await expect(f.prisma.topic.update({ where: { id: draft.topics[0].id }, data: {
            title: 'Forbidden published edit',
          } })).rejects.toThrow();
        });
      }, 30_000);
    }

    for (const name of ['mentor', 'student', 'inactiveOwner', 'inactiveAdmin', 'foreignOwner', 'foreignAdmin']) {
      test(`AC01 ${name} cannot publish through ${entryPoint} or mutate curriculum`, async () => {
        await withFixture(async (f) => {
          const draft = await f.draft();
          await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), name);
        });
      }, 30_000);
    }

    test(`AC01 unauthenticated ${entryPoint} publication is rejected before mutation`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), null, 401);
      });
    }, 30_000);

    test(`AC01 inactive organization blocks ${entryPoint} publication by its Owner`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        await f.prisma.organization.update({ where: { id: f.organization.id }, data: { status: 'inactive' } });
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), 'owner');
      });
    }, 30_000);

    test(`AC01 suspended account blocks ${entryPoint} publication despite an active Owner membership`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        await f.auth('owner');
        await f.prisma.user.update({ where: { id: f.actors.owner.user.id }, data: { status: 'suspended' } });
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), 'owner', 401);
      });
    }, 30_000);

    for (const change of ['demoted', 'deactivated']) {
      test(`AC01 ${entryPoint} rechecks an Admin ${change} while publication waits for its transaction lock`, async () => {
        await withFixture(async (f) => {
          const draft = await f.draft();
          const headers = await f.auth('admin');
          const before = await f.snapshot();
          const control = new pg.Client({ connectionString: f.connectionString });
          await control.connect();
          let pending;
          let response;
          try {
            await control.query('BEGIN');
            await control.query('SELECT id FROM organizations WHERE id = $1::uuid FOR UPDATE', [f.organization.id]);
            pending = request(f.app).post(publicationPath(entryPoint, draft, f.organization.id))
              .set(headers).then(result => result);
            // Observe the real transaction blocked after its initial policy check;
            // no mocked permission result or arbitrary sleep selects the race.
            let waiting = false;
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
              // PostgreSQL caches activity statistics within this control
              // transaction; refresh them before observing the waiting session.
              await control.query('SELECT pg_stat_clear_snapshot()');
              const result = await control.query(`SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND application_name = $1
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                AND query LIKE '%FROM organizations%FOR UPDATE%'`, [f.applicationName]);
              if (result.rowCount) { waiting = true; break; }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            expect(waiting).toBe(true);
            if (change === 'demoted') {
              await control.query("UPDATE organization_memberships SET role = 'coordinator' WHERE id = $1::uuid", [f.actors.admin.membership.id]);
            } else {
              await control.query("UPDATE organization_memberships SET status = 'inactive' WHERE id = $1::uuid", [f.actors.admin.membership.id]);
            }
            await control.query('COMMIT');
            response = await pending;
          } finally {
            await control.query('ROLLBACK').catch(() => {});
            await control.end();
            await pending?.catch(() => {});
          }
          expect.soft(response.status).toBe(403);
          expect(await f.snapshot()).toEqual(before);
        });
      }, 30_000);
    }

    test(`AC01 ${entryPoint} preserves Coordinator drafting, copies, archived content and cohort pins`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        const versionPath = `/api/v1/organizations/${f.organization.id}/roadmaps/${draft.id}/versions/${draft.version_id}`;
        const edited = await request(f.app).put(versionPath).set(await f.auth('coordinator')).send({
          phases: [{ title: 'Coordinator phase', weeks: [{ title: 'Coordinator week', topics: [
            { title: 'Coordinator-edited topic', description: 'Draft editing remains allowed.' },
          ] }] }],
        });
        expect(edited.status).toBe(200);
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), 'coordinator');
        expect((await request(f.app).post(publicationPath(entryPoint, draft, f.organization.id))
          .set(await f.auth('owner'))).status).toBe(200);
        const cohort = await request(f.app).post(`/api/v1/organizations/${f.organization.id}/cohorts`)
          .set(await f.auth('owner')).send({ name: 'Pinned cohort', roadmap_version_id: draft.version_id });
        expect(cohort.status).toBe(201);
        const copy = await request(f.app).post(`/api/v1/roadmaps/${draft.id}/versions`)
          .set(await f.auth('coordinator')).send({ source_version_id: draft.version_id });
        expect(copy.status).toBe(201);
        expect(copy.body.status).toBe('draft');
        expect(copy.body.topics[0].id).not.toBe(edited.body.topics[0].id);
        expect((await request(f.app).patch(`/api/v1/roadmap-versions/${copy.body.version_id}`)
          .set(await f.auth('coordinator')).send({ phases: [] })).status).toBe(200);
        expect((await request(f.app).put(versionPath).set(await f.auth('coordinator'))
          .send({ phases: [] })).status).toBe(409);
        expect((await request(f.app).post(`/api/v1/roadmap-versions/${draft.version_id}/archive`)
          .set(await f.auth('owner'))).status).toBe(200);
        await expect(f.prisma.topic.update({ where: { id: edited.body.topics[0].id }, data: {
          title: 'Forbidden archived edit',
        } })).rejects.toThrow();
        expect((await f.prisma.cohort.findUnique({ where: { id: cohort.body.id } })).roadmapVersionId)
          .toBe(draft.version_id);
        expect((await f.prisma.topic.findUnique({ where: { id: edited.body.topics[0].id } })).title)
          .toBe('Coordinator-edited topic');
      });
    }, 30_000);

    test(`AC01 PDF-converted drafts retain Coordinator conversion but require Owner/Admin ${entryPoint} publication`, async () => {
      await withFixture(async (f) => {
        // A ready extraction fixture exercises the real converter; existing PDF
        // integration tests separately cover upload, parsing and private storage.
        const plan = await f.prisma.activityPlan.create({ data: {
          organizationId: f.organization.id, uploadedBy: f.actors.coordinator.user.id,
          name: 'Reviewed PDF fixture', filename: 'fixture.pdf',
          objectKey: `ac01/${randomUUID()}.pdf`, sha256: '0'.repeat(64), byteCount: 5,
          status: 'ready', reviewConfirmed: true, reviewItems: [],
          proposal: { phases: [{ id: 'phase', title: 'Imported phase', weeks: [{
            id: 'week', title: 'Imported week', topics: [{
              id: 'topic', title: 'Imported topic', description: '', source_refs: [],
            }],
          }] }] },
        } });
        const convertPath = `/api/v1/organizations/${f.organization.id}/activity-plans/${plan.id}/convert`;
        const converted = await request(f.app).post(convertPath).set(await f.auth('coordinator'))
          .send({ revision: plan.revision });
        expect(converted.status).toBe(201);
        const draft = { id: converted.body.roadmap_id, version_id: converted.body.version_id };
        await f.expectDenied(publicationPath(entryPoint, draft, f.organization.id), 'coordinator');
        expect((await request(f.app).post(convertPath).set(await f.auth('coordinator'))
          .send({ revision: plan.revision })).body).toMatchObject(converted.body);
        const published = await request(f.app).post(publicationPath(entryPoint, draft, f.organization.id))
          .set(await f.auth(entryPoint === 'nested' ? 'owner' : 'admin'));
        expect(published.status).toBe(200);
        expect(published.body.topics.map(topic => topic.title)).toEqual(['Imported topic']);
        expect((await f.prisma.activityPlan.findUnique({ where: { id: plan.id } })).versionId)
          .toBe(draft.version_id);
      });
    }, 30_000);
  }

  for (const mismatch of ['organization', 'roadmap', 'version']) {
    test(`AC01 nested ${mismatch} ownership mismatch cannot modify either version`, async () => {
      await withFixture(async (f) => {
        const draft = await f.draft();
        const other = await f.draft('foreignOwner', f.foreignOrganization.id);
        const organizationId = mismatch === 'organization' ? f.foreignOrganization.id : f.organization.id;
        const pathDraft = {
          id: mismatch === 'roadmap' ? other.id : draft.id,
          version_id: mismatch === 'version' ? other.version_id : draft.version_id,
        };
        await f.expectDenied(publicationPath('nested', pathDraft, organizationId),
          mismatch === 'organization' ? 'foreignOwner' : 'owner', 404);
      });
    }, 30_000);
  }
});
