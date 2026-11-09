import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPrismaClient } from '../../src/db/client.js';
import { issueSession } from '../../src/modules/auth/service.js';
import { readVersion, submitRoadmap, publishRoadmap, archiveRoadmap } from '../helpers/roadmapWorkflow.js';

const databaseUrl = process.env.T04D_DATABASE_URL;
async function fixture(run) {
  if (!/^\/outpost_t04c_[a-f0-9]+$/.test(new URL(databaseUrl).pathname)) throw new Error('Requires a newly provisioned disposable database');
  const name = `t04d-${randomUUID()}`;
  const url = new URL(databaseUrl); url.searchParams.set('application_name', name);
  const prisma = createPrismaClient(url.href);
  const app = createApp({ prisma, settings: { env: 'test', authSigningKey: randomBytes(48).toString('base64url') } });
  const settings = app.locals.settings;
  try {
    const org = await prisma.organization.create({ data: { name: 'Review campus', slug: name } });
    const otherOrg = await prisma.organization.create({ data: { name: 'Other campus', slug: `${name}-other` } });
    const actors = {};
    for (const role of ['owner', 'admin', 'coordinator', 'mentor', 'student', 'foreignOwner', 'inactiveAdmin']) {
      const user = await prisma.user.create({ data: { displayName: role, primaryEmail: `${role}-${name}@example.test`, accountType: role === 'student' ? 'student' : 'coordinator' } });
      const membership = await prisma.organizationMembership.create({ data: { userId: user.id,
        organizationId: role === 'foreignOwner' ? otherOrg.id : org.id,
        role: role === 'foreignOwner' ? 'owner' : role === 'inactiveAdmin' ? 'admin' : role,
        status: role === 'inactiveAdmin' ? 'inactive' : 'active' } });
      const session = await issueSession(prisma, settings, user, 'test', { get: () => undefined });
      actors[role] = { user, membership, headers: { Authorization: `Bearer ${session.access}` } };
    }
    const auth = role => actors[role].headers;
    const draft = async (role = 'coordinator') => {
      const result = await request(app).post(`/api/v1/organizations/${org.id}/roadmaps`).set(auth(role))
        .send({ name: 'Governed plan', topics: [{ title: 'Transactions' }] });
      expect(result.status).toBe(201); expect(result.body.revision).toBe(1); return result.body;
    };
    const path = (d, action, nested = false) => nested
      ? `/api/v1/organizations/${org.id}/roadmaps/${d.id}/versions/${d.version_id}/${action}`
      : `/api/v1/roadmap-versions/${d.version_id}/${action}`;
    const pending = d => submitRoadmap(app, d.version_id, auth('coordinator'));
    const decision = d => ({ revision: d.revision, submission_id: d.pending_submission.id });
    const snapshot = async id => ({
      version: await prisma.roadmapVersion.findUnique({ where: { id } }),
      attempts: await prisma.roadmapReviewAttempt.findMany({ where: { versionId: id }, orderBy: { submittedRevision: 'asc' } }),
      events: await prisma.auditEvent.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } }),
      phases: await prisma.phase.findMany({ where: { roadmapVersionId: id }, include: { weeks: { include: { topics: true } } } }),
    });
    await run({ prisma, app, org, otherOrg, actors, auth, draft, path, pending, decision, snapshot, url: url.href, name });
  } finally { await prisma.$disconnect(); }
}

describe.skipIf(!databaseUrl)('T04-D real PostgreSQL roadmap API', () => {
  const allowed = ['owner', 'admin', 'coordinator'];
  for (const action of ['create', 'edit', 'submit', 'reviews', 'approve', 'reject', 'archive', 'copy']) {
    for (const role of ['owner', 'admin', 'coordinator', 'mentor', 'student']) {
      test(`[authorization] ${role} ${action}`, async () => fixture(async f => {
        let d = await f.draft();
        if (['approve', 'reject', 'reviews'].includes(action)) d = await f.pending(d);
        if (['archive', 'copy'].includes(action)) d = (await publishRoadmap(f.app, d.version_id, f.auth('owner'))).body;
        const can = (['approve', 'reject'].includes(action) ? ['owner', 'admin'] : allowed).includes(role);
        let call;
        if (action === 'create') call = request(f.app).post(`/api/v1/organizations/${f.org.id}/roadmaps`).send({ name: 'New plan', topics: [{ title: 'New topic' }] });
        else if (action === 'edit') call = request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).send({ revision: d.revision, phases: [] });
        else if (action === 'reviews') call = request(f.app).get(f.path(d, action));
        else if (action === 'copy') call = request(f.app).post(`/api/v1/roadmaps/${d.id}/versions`).send({ source_version_id: d.version_id, revision: d.revision });
        else call = request(f.app).post(f.path(d, action)).send(['approve', 'reject'].includes(action)
          ? { ...f.decision(d), ...(action === 'reject' ? { reason: 'Add transaction exercises' } : {}) } : { revision: d.revision });
        const before = await f.snapshot(d.version_id);
        const result = await call.set(f.auth(role));
        expect(result.status).toBe(can ? ['create', 'copy'].includes(action) ? 201 : 200 : 403);
        if (!can) expect(await f.snapshot(d.version_id)).toEqual(before);
      }), 30000);
    }
  }
  for (const role of ['owner', 'admin']) test(`[review] ${role} may approve own submission`, async () => fixture(async f => {
    const d = await f.draft(role); const s = await submitRoadmap(f.app, d.version_id, f.auth(role));
    const result = await request(f.app).post(f.path(s, 'approve')).set(f.auth(role)).send(f.decision(s));
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: 'published', revision: s.revision + 1, pending_submission: null });
    const state = await f.snapshot(d.version_id);
    expect(state.attempts[0]).toMatchObject({ decision: 'approved', submittedBy: f.actors[role].user.id, reviewedBy: f.actors[role].user.id });
    const [exact] = await f.prisma.$queryRaw`SELECT rv.published_at = a.reviewed_at AS equal
      FROM roadmap_versions rv JOIN roadmap_review_attempts a ON a.version_id=rv.id WHERE rv.id=${d.version_id}::uuid`;
    expect(exact.equal).toBe(true);
  }));
  for (const nested of [false, true]) for (const role of ['owner', 'admin']) test(`[compatibility] ${role} cannot directly publish ${nested ? 'nested' : 'canonical'} draft`, async () => fixture(async f => {
    const d = await f.draft(); const before = await f.snapshot(d.version_id);
    const result = await request(f.app).post(f.path(d, 'publish', nested)).set(f.auth(role)).send({ revision: d.revision, submission_id: randomUUID() });
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('conflict'); expect(await f.snapshot(d.version_id)).toEqual(before);
  }));
  for (const action of ['submit', 'approve', 'reject', 'archive', 'reviews']) {
    for (const role of ['inactiveAdmin', 'foreignOwner']) test(`[authorization] ${role} cannot ${action}`, async () => fixture(async f => {
      const d = await f.draft(); const s = await f.pending(d);
      const call = action === 'reviews' ? request(f.app).get(f.path(d, action)) : request(f.app).post(f.path(d, action)).send({ ...f.decision(s), reason: 'Feedback' });
      expect((await call.set(f.auth(role))).status).toBe(403);
    }));
  }
  test('[submission] rejects incomplete, stale and duplicate submissions; freezes content', async () => fixture(async f => {
    const d = await f.draft();
    expect((await request(f.app).post(f.path(d, 'submit')).send({ revision: d.revision })).status).toBe(401);
    expect((await request(f.app).post(f.path(d, 'submit')).set(f.auth('coordinator')).send({ revision: d.revision + 1 })).status).toBe(409);
    const empty = await request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')).send({ revision: d.revision, phases: [] });
    expect(empty.status).toBe(200); expect(empty.body.revision).toBe(d.revision + 1);
    expect((await request(f.app).post(f.path(d, 'submit')).set(f.auth('coordinator')).send({ revision: empty.body.revision })).status).toBe(422);
    const e = await f.draft(); const s = await f.pending(e);
    expect((await request(f.app).post(f.path(e, 'submit')).set(f.auth('coordinator')).send({ revision: s.revision })).status).toBe(409);
    expect((await request(f.app).patch(`/api/v1/roadmap-versions/${e.version_id}`).set(f.auth('coordinator')).send({ revision: s.revision, phases: [] })).status).toBe(409);
    expect(await f.prisma.roadmapReviewAttempt.count({ where: { versionId: e.version_id } })).toBe(1);
  }));
  for (const body of [{}, { revision: '1' }, { revision: 0 }, { revision: 1, submitted_by: randomUUID() }, { revision: 1, organization_id: randomUUID() }, { revision: 1, status: 'published' }]) {
    test(`[validation] submission rejects ${JSON.stringify(body)}`, async () => fixture(async f => {
      const d = await f.draft();
      expect((await request(f.app).post(f.path(d, 'submit')).set(f.auth('coordinator')).send(body)).status).toBe(422);
      expect((await f.snapshot(d.version_id)).events).toHaveLength(0);
    }));
  }
  for (const reason of [undefined, '', ' \n\t\u00a0', 'a'.repeat(2001)]) test(`[validation] rejection reason ${reason?.length ?? 'missing'}`, async () => fixture(async f => {
    const d = await f.draft(); const s = await f.pending(d);
    expect((await request(f.app).post(f.path(d, 'reject')).set(f.auth('admin')).send({ ...f.decision(s), reason })).status).toBe(422);
    expect((await f.snapshot(d.version_id)).attempts[0].decision).toBe('pending');
  }));
  test('[review] rejection, edited resubmission, feedback history and bounded pagination', async () => fixture(async f => {
    const d = await f.draft(); let s = await f.pending(d); const first = s.pending_submission.id;
    for (const reason of ['Add examples', 'a'.repeat(2000)]) {
      const rejected = await request(f.app).post(f.path(d, 'reject')).set(f.auth('admin')).send({ ...f.decision(s), reason });
      expect(rejected.status).toBe(200); expect(rejected.body.status).toBe('draft');
      const edited = await request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator'))
        .send({ revision: rejected.body.revision, phases: [{ title: 'Revised phase', weeks: [{
          title: 'Revised week', topics: [{ title: 'Transaction exercises' }],
        }] }] });
      expect(edited.status).toBe(200);
      expect(edited.body.revision).toBe(rejected.body.revision + 1);
      s = await f.pending(d);
      expect(s.revision).toBe(edited.body.revision + 1);
    }
    const history = await request(f.app).get(`${f.path(d, 'reviews')}?limit=1`).set(f.auth('coordinator'));
    expect(history.status).toBe(200); expect(history.body.reviews).toHaveLength(1);
    expect(history.body.pagination.next_offset).toBe(1); expect(history.body.pending_submission.id).toBe(s.pending_submission.id);
    const page2 = await request(f.app).get(`${f.path(d, 'reviews')}?limit=1&offset=1`).set(f.auth('owner'));
    expect(page2.body.reviews[0].rejection_reason).toHaveLength(2000);
    const all = await request(f.app).get(f.path(d, 'reviews')).set(f.auth('admin'));
    expect(all.body.reviews.at(-1)).toMatchObject({ id: first, rejection_reason: 'Add examples' });
    expect(JSON.stringify(all.body)).not.toMatch(/primaryEmail|primary_email|@example|authSession/);
    expect((await request(f.app).get(`${f.path(d, 'reviews')}?limit=101`).set(f.auth('owner'))).status).toBe(422);
  }));
  test('[compatibility] rejects missing/spoofed decision identity, wrong pending ID and cross-version substitution', async () => fixture(async f => {
    const a = await f.draft(); const b = await f.draft(); const s = await f.pending(a); const t = await f.pending(b);
    for (const input of [{ revision: s.revision }, { ...f.decision(s), reviewed_by: f.actors.owner.user.id }, { ...f.decision(s), actor_id: f.actors.owner.user.id }]) {
      expect((await request(f.app).post(f.path(a, 'approve')).set(f.auth('owner')).send(input)).status).toBe(422);
    }
    for (const id of [randomUUID(), t.pending_submission.id]) expect((await request(f.app).post(f.path(a, 'approve')).set(f.auth('owner')).send({ revision: s.revision, submission_id: id })).status).toBe(409);
    const path = `/api/v1/organizations/${f.otherOrg.id}/roadmaps/${a.id}/versions/${a.version_id}/approve`;
    expect((await request(f.app).post(path).set(f.auth('foreignOwner')).send(f.decision(s))).status).toBe(404);
    expect((await request(f.app).get(`/api/v1/roadmap-versions/${randomUUID()}/reviews`).set(f.auth('owner'))).status).toBe(404);
  }));
  for (const pair of [['submit', 'submit'], ['approve', 'approve'], ['approve', 'reject'], ['edit', 'submit']]) {
    test(`[concurrency] K${pair[0] === 'submit' ? '1' : pair[0] === 'edit' ? '4' : pair[1] === 'reject' ? '3' : '2'} ${pair.join(' versus ')}`, async () => fixture(async f => {
      const d = await f.draft(); const s = pair.includes('approve') ? await f.pending(d) : d;
      const calls = pair.map(action => action === 'edit'
        ? request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')).send({ revision: s.revision, phases: [] })
        : request(f.app).post(f.path(d, action)).set(f.auth(action === 'submit' ? 'coordinator' : 'admin'))
          .send(action === 'submit' ? { revision: s.revision } : { ...f.decision(s), ...(action === 'reject' ? { reason: 'Revise examples' } : {}) }));
      const results = await Promise.all(calls); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      const state = await f.snapshot(d.version_id);
      expect(state.attempts.filter(a => a.decision === 'pending').length).toBeLessThanOrEqual(1);
      expect(state.events.filter(e => ['roadmap.approved_published', 'roadmap.rejected'].includes(e.action)).length).toBe(pair.includes('approve') ? 1 : 0);
    }), 30000);
  }
  for (const change of ['demoted', 'inactive', 'suspended', 'revoked']) test(`[concurrency] K${['demoted', 'inactive'].includes(change) ? '5' : '6'} actor ${change} before transactional revalidation`, async () => fixture(async f => {
    const d = await f.draft(); const s = await f.pending(d);
    const control = new pg.Client({ connectionString: f.url }); await control.connect(); let pending;
    try {
      await control.query('BEGIN'); await control.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.org.id]);
      pending = request(f.app).post(f.path(d, 'approve')).set(f.auth('admin')).send(f.decision(s)).then(r => r);
      let waiting = false; const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await control.query('SELECT pg_stat_clear_snapshot()');
        const result = await control.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()
          AND wait_event_type='Lock' AND query LIKE '%FROM organizations%FOR UPDATE%'`, [f.name]);
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      expect(waiting).toBe(true);
      if (change === 'demoted') await control.query("UPDATE organization_memberships SET role='coordinator' WHERE id=$1", [f.actors.admin.membership.id]);
      if (change === 'inactive') await control.query("UPDATE organization_memberships SET status='inactive' WHERE id=$1", [f.actors.admin.membership.id]);
      if (change === 'suspended') await control.query("UPDATE users SET status='suspended' WHERE id=$1", [f.actors.admin.user.id]);
      if (change === 'revoked') await control.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1', [f.actors.admin.user.id]);
      await control.query('COMMIT'); const result = await pending;
      expect(result.status).toBe(['suspended', 'revoked'].includes(change) ? 401 : 403);
      expect((await f.snapshot(d.version_id)).attempts[0].decision).toBe('pending');
    } finally { await control.query('ROLLBACK').catch(() => {}); await control.end(); await pending?.catch(() => {}); }
  }), 30000);
  test('[audit] K7 failed real audit insertion rolls back decision, status, revision and event', async () => fixture(async f => {
    const d = await f.draft(); const s = await f.pending(d); const before = await f.snapshot(d.version_id);
    const name = `fail_audit_${randomUUID().replaceAll('-', '')}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.entity_id='${d.version_id}'::uuid THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='23514'; END IF;
        RETURN NEW; END $$`);
      await f.prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const result = await request(f.app).post(f.path(d, 'approve')).set(f.auth('owner')).send(f.decision(s));
      expect(result.status).toBe(500); expect(result.body.error.message).toBe('Internal server error');
      expect(await f.snapshot(d.version_id)).toEqual(before);
      expect(log).toHaveBeenCalledWith('roadmap.transaction_failed', expect.objectContaining({ requestId: expect.any(String) }));
    } finally {
      await f.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
      await f.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`); log.mockRestore();
    }
  }));
  test('[concurrency] K8 old rejected attempt cannot approve a newer resubmission', async () => fixture(async f => {
    const d = await f.draft(); const a = await f.pending(d);
    expect((await request(f.app).post(f.path(d, 'reject')).set(f.auth('owner')).send({ ...f.decision(a), reason: 'Add labs' })).status).toBe(200);
    const b = await f.pending(d); const before = await f.snapshot(d.version_id);
    expect((await request(f.app).post(f.path(d, 'approve')).set(f.auth('owner')).send({ revision: b.revision, submission_id: a.pending_submission.id })).status).toBe(409);
    expect(await f.snapshot(d.version_id)).toEqual(before);
  }));
  test('[audit] successful events carry server-derived IDs, request correlation and allowlisted metadata', async () => fixture(async f => {
    const d = await f.draft(); const s = await f.pending(d); const requestId = randomUUID();
    const result = await request(f.app).post(f.path(d, 'approve')).set(f.auth('admin')).set('X-Request-ID', requestId).send(f.decision(s));
    expect(result.status).toBe(200);
    const state = await f.snapshot(d.version_id);
    expect(state.events.map(e => e.action)).toEqual(['roadmap.submitted', 'roadmap.approved_published']);
    expect(state.events[1]).toMatchObject({ actorId: f.actors.admin.user.id, organizationId: f.org.id, requestId,
      metadata: { revision: result.body.revision, reviewAttemptId: s.pending_submission.id } });
    expect(Object.keys(state.events[1].metadata).sort()).toEqual(['reviewAttemptId', 'revision']);
  }));
  test('[lifecycle] archive and archived copy preserve cohort pins/progress and allocate independent identities', async () => fixture(async f => {
    const d = await f.draft(); const published = (await publishRoadmap(f.app, d.version_id, f.auth('owner'))).body;
    const cohort = await request(f.app).post(`/api/v1/organizations/${f.org.id}/cohorts`).set(f.auth('coordinator'))
      .send({ name: 'Pinned class', roadmap_version_id: d.version_id });
    expect(cohort.status).toBe(201);
    await f.prisma.cohortEnrollment.create({ data: { cohortId: cohort.body.id, userId: f.actors.student.user.id } });
    await f.prisma.topicProgress.create({ data: { userId: f.actors.student.user.id, topicId: published.topics[0].id, status: 'completed' } });
    const archived = await archiveRoadmap(f.app, d.version_id, f.auth('coordinator'));
    expect(archived.status).toBe(200); expect(archived.body.published_at).toBe(published.published_at);
    expect((await request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')).send({ revision: archived.body.revision, phases: [] })).status).toBe(409);
    const copy = await request(f.app).post(`/api/v1/roadmaps/${d.id}/versions`).set(f.auth('coordinator'))
      .send({ source_version_id: d.version_id, revision: archived.body.revision });
    expect(copy.status).toBe(201); expect(copy.body).toMatchObject({ status: 'draft', revision: 1, pending_submission: null });
    expect(copy.body.topics[0].id).not.toBe(published.topics[0].id);
    expect(await f.prisma.roadmapReviewAttempt.count({ where: { versionId: copy.body.version_id } })).toBe(0);
    expect((await f.prisma.cohort.findUnique({ where: { id: cohort.body.id } })).roadmapVersionId).toBe(d.version_id);
    expect(await f.prisma.topicProgress.findFirst({ where: { userId: f.actors.student.user.id } })).toMatchObject({ topicId: published.topics[0].id, status: 'completed' });
    const s = await f.pending(copy.body);
    expect((await request(f.app).post(`/api/v1/roadmaps/${d.id}/versions`).set(f.auth('coordinator')).send({ source_version_id: s.version_id, revision: s.revision })).status).toBe(409);
  }));
  test('[revision] 500-topic API replacement advances once and stale edits preserve the saved tree', async () => fixture(async f => {
    const d = await f.draft();
    const phases = [{ title: 'Large phase', weeks: Array.from({ length: 25 }, (_, w) => ({
      title: `Week ${w + 1}`, topics: Array.from({ length: 20 }, (_, t) => ({ title: `Topic ${w + 1}.${t + 1}` })),
    })) }];
    const result = await request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')).send({ revision: d.revision, phases });
    expect(result.status).toBe(200); expect(result.body.revision).toBe(d.revision + 1); expect(result.body.topics).toHaveLength(500);
    expect((await request(f.app).patch(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')).send({ revision: d.revision, phases: [] })).status).toBe(409);
    expect((await readVersion(f.app, d.version_id, f.auth('owner'))).topics).toEqual(result.body.topics);
  }), 30000);
  test('[snapshot] version reads remain coherent while a decision commits', async () => fixture(async f => {
    const d = await f.draft(); const s = await f.pending(d);
    const calls = Array.from({ length: 8 }, () => request(f.app).get(`/api/v1/roadmap-versions/${d.version_id}`).set(f.auth('coordinator')));
    const approval = request(f.app).post(f.path(d, 'approve')).set(f.auth('owner')).send(f.decision(s));
    const responses = await Promise.all([...calls, approval]);
    for (const response of responses) {
      expect(response.status).toBe(200); const v = response.body; expect(v.topics).toHaveLength(1);
      if (v.status === 'in_review') {
        expect(v.revision).toBe(s.revision); expect(v.pending_submission).toMatchObject({ id: s.pending_submission.id, submitted_revision: v.revision, decision: 'pending' });
      } else { expect(v.status).toBe('published'); expect(v.revision).toBe(s.revision + 1); expect(v.pending_submission).toBeNull(); }
    }
  }));
});
