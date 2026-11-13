import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPrismaClient } from '../../src/db/client.js';
import { issueSession } from '../../src/modules/auth/service.js';
import { publishRoadmap, archiveRoadmap } from '../helpers/roadmapWorkflow.js';

const databaseUrl = process.env.M02_TEST_DATABASE_URL;
const settings = { env: 'test', authSigningKey: randomUUID() + randomUUID() };
const timeout = 45_000;

describe.skipIf(!databaseUrl)('M02 Mentor assignments on disposable PostgreSQL', () => {
  let prisma, api, campus, other, first, second, foreign, initial, topic, week, staff, student;
  const owner = 'owner';
  const organizationPath = (org = campus) => '/api/v1/organizations/' + org.id;
  const assignment = (cohort = first, member = staff.mentor.membership, org = campus) =>
    organizationPath(org) + '/cohorts/' + cohort.id + '/mentor-assignments/' + member.id;
  const detail = (cohort = first, org = campus) => organizationPath(org) + '/mentor/cohorts/' + cohort.id;
  const send = (method, path, actor, client = api) => client[method](path).set(actor.header);
  const mentor = () => staff.mentor;
  const ownerUser = () => staff.owner;

  function holdTransaction(beforeOperation) {
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    const client = new Proxy(prisma, {
      get(target, key) {
        if (key === '$transaction') return (operation, options) => target.$transaction(async (tx) => {
          if (beforeOperation) {
            await beforeOperation(tx);
            reached.resolve();
            await release.promise;
            return operation(tx);
          }
          const result = await operation(tx);
          reached.resolve();
          await release.promise;
          return result;
        }, { ...options, timeout: 20_000 });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { reached: reached.promise, release: release.resolve, api: request(createApp({ prisma: client, settings })) };
  }

  async function whileHeld(start, check, beforeOperation) {
    const held = holdTransaction(beforeOperation);
    const pending = start(held.api).then((response) => response);
    try {
      await Promise.race([held.reached, pending.then(({ status }) => { throw new Error('Request ended before hold: ' + status); })]);
      await check();
    } finally {
      held.release();
      await pending;
    }
    return pending;
  }

  async function account(role, org = campus, status = 'active') {
    const id = randomUUID();
    const user = await prisma.user.create({ data: {
      id, displayName: 'Fixture ' + role, status, primaryEmail: id + '@example.test',
      accountType: role === 'student' ? 'student' : 'coordinator',
    } });
    const membership = await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: id, role } });
    const token = status === 'active' ? await issueSession(prisma, settings, user, 'fixture', { get: () => undefined }) : null;
    return { user, membership, header: { Authorization: 'Bearer ' + token?.access }, refresh: token?.refresh };
  }

  async function roadmap(org, actor) {
    const app = createApp({ prisma, settings });
    const result = await send('post', organizationPath(org) + '/roadmaps', actor)
      .send({ name: 'Exact pin', topics: [{ title: 'Pinned topic' }, { title: 'Another topic' }] });
    expect(result.status).toBe(201);
    await publishRoadmap(app, result.body.version_id, actor.header);
    return result.body;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl.replace(/^postgresql\+psycopg:\/\//, 'postgresql://'));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5433' || !/^\/outpost_m02_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error('M02 requires its own loopback disposable database');
    }
    prisma = createPrismaClient(databaseUrl);
    const [identity] = await prisma.$queryRaw`SELECT current_database() AS name`;
    expect(identity.name).toBe(url.pathname.slice(1));
    api = request(createApp({ prisma, settings, redisClient: { eval: async () => 1 } }));
    const createOrg = (name) => prisma.organization.create({ data: { name, slug: randomUUID() } });
    campus = await createOrg('Fixture campus');
    other = await createOrg('Foreign campus');
    staff = {};
    for (const role of ['owner', 'admin', 'coordinator', 'mentor']) staff[role] = await account(role);
    staff.secondOwner = await account('owner');
    staff.secondMentor = await account('mentor');
    staff.foreignMentor = await account('mentor', other);
    const otherOwner = await account('owner', other);
    student = await account('student');
    initial = await roadmap(campus, staff.owner);
    const otherPlan = await roadmap(other, otherOwner);
    const createCohort = (org, actor, name, version) => send('post', organizationPath(org) + '/cohorts', actor)
      .send({ name, roadmap_version_id: version }).expect(201).then((response) => response.body);
    first = await createCohort(campus, staff.owner, 'Assigned cohort', initial.version_id);
    second = await createCohort(campus, staff.owner, 'Other cohort', initial.version_id);
    foreign = await createCohort(other, otherOwner, 'Foreign cohort', otherPlan.version_id);
    topic = await prisma.topic.findUnique({ where: { id: initial.topics[0].id } });
    week = await prisma.week.findUnique({ where: { id: topic.weekId } });
  }, timeout);

  afterAll(async () => { await prisma?.$disconnect(); });

  it('S01, S06–S08 Owner assign is tenant-scoped, idempotent, and audited once under concurrency', async () => {
    const attempts = await Promise.all([
      send('put', assignment(), staff.secondOwner),
      send('put', assignment(), ownerUser()),
    ]);
    expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
    expect(attempts[0].body.id).toBe(attempts[1].body.id);
    expect((await send('put', assignment(), ownerUser())).body.id).toBe(attempts[0].body.id);
    expect((await send('put', assignment(first, staff.foreignMentor.membership), ownerUser())).status).toBe(404);
    expect((await send('put', assignment(foreign), ownerUser())).status).toBe(404);
    expect((await send('put', assignment(first, staff.admin.membership), ownerUser())).status).toBe(409);
    expect(await prisma.auditEvent.count({ where: {
      entityId: attempts[0].body.id, action: 'mentor_assignment.assigned',
    } })).toBe(1);
    const scoped = await send('get', organizationPath() + '/cohorts/' + first.id + '/mentor-assignments', ownerUser());
    expect(scoped.body.assignments).toHaveLength(1);
  }, timeout);

  it('S02–S05 only an active Owner can mutate, including Mentor self-assignment', async () => {
    for (const actor of [staff.admin, staff.coordinator, student, mentor()]) {
      expect((await send('put', assignment(), actor)).status).toBe(403);
      expect((await send('delete', assignment(), actor)).status).toBe(403);
      expect((await send('get', organizationPath() + '/mentor-assignments', actor)).status).toBe(403);
    }
  }, timeout);

  it('S21 orders assignment after a concurrent membership deactivation', async () => {
    const m = staff.secondMentor;
    const memberPath = organizationPath() + '/members/' + m.membership.id;
    const link = assignment(second, m.membership);
    let competing;
    const deactivated = await whileHeld(
      (client) => send('patch', memberPath, ownerUser(), client).send({ status: 'inactive' }),
      async () => {
        competing = send('put', link, staff.secondOwner).then((response) => response);
        await waitForOrganizationLock();
      },
    );
    expect(deactivated.status).toBe(200);
    expect((await competing).status).toBe(409);
    await send('get', detail(second), m).expect(403);
    await send('patch', memberPath, ownerUser()).send({ status: 'active' }).expect(200);
    const assigned = await whileHeld(
      (client) => send('put', link, ownerUser(), client),
      async () => {
        competing = send('patch', memberPath, staff.secondOwner).send({ status: 'inactive' }).then((response) => response);
        await waitForOrganizationLock();
      },
    );
    expect(assigned.status).toBe(200);
    expect((await competing).status).toBe(200);
    await send('get', detail(second), m).expect(403);
    await send('delete', link, ownerUser()).expect(204);
    await send('patch', memberPath, ownerUser()).send({ status: 'active' }).expect(200);
  }, timeout);

  it('S22 and S23 use the read snapshot and serialize revoke followed by reassignment', async () => {
    const m = staff.secondMentor;
    const link = assignment(second, m.membership);
    await send('put', link, ownerUser()).expect(200);
    const priorRead = await whileHeld(
      (client) => send('get', detail(second), m, client),
      async () => {
        await send('delete', link, ownerUser()).expect(204);
        await send('get', detail(second), m).expect(404);
      },
      async (tx) => {
        const [setting] = await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS isolation, pg_current_snapshot()::text AS snapshot`;
        expect(setting.isolation).toBe('repeatable read');
      },
    );
    expect(priorRead.status).toBe(200);
    const before = await send('put', link, ownerUser()).expect(200);
    let competing;
    const revoked = await whileHeld(
      (client) => send('delete', link, ownerUser(), client),
      async () => {
        competing = send('put', link, staff.secondOwner).then((response) => response);
        await waitForOrganizationLock();
      },
    );
    expect(revoked.status).toBe(204);
    const renewed = await competing;
    expect(renewed.status).toBe(200);
    expect(renewed.body.id).not.toBe(before.body.id);
    await send('get', detail(second), m).expect(200);
    const repeated = await whileHeld(
      (client) => send('put', link, ownerUser(), client),
      async () => {
        competing = send('delete', link, staff.secondOwner).then((response) => response);
        await waitForOrganizationLock();
      },
    );
    expect(repeated.body.id).toBe(renewed.body.id);
    expect((await competing).status).toBe(204);
    await send('get', detail(second), m).expect(404);
  }, timeout);

  it('S27 rejects a queued Owner mutation after its authenticated session is revoked', async () => {
    const issued = await issueSession(prisma, settings, ownerUser().user, 'fixture', { get: () => undefined });
    const actor = { header: { Authorization: 'Bearer ' + issued.access } };
    const link = assignment(second, staff.secondMentor.membership);
    let competing;
    const lock = await whileHeld(
      (client) => send('put', link, staff.secondOwner, client),
      async () => {
        competing = send('delete', link, actor).then((response) => response);
        await waitForOrganizationLock();
        await send('post', '/api/v1/auth/logout', actor).expect(204);
      },
    );
    expect(lock.status).toBe(200);
    expect((await competing).status).toBe(401);
    await send('get', detail(second), staff.secondMentor).expect(200);
    await send('delete', link, ownerUser()).expect(204);
  }, timeout);

  async function waitForOrganizationLock() {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const [result] = await prisma.$queryRaw`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%FROM organizations%FOR UPDATE%'
      ) AS waiting`;
      if (result.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Competing request did not wait for the organization lock');
  }

  it('S09–S16, S24–S25, S29–S30 returns the immutable pin and privacy-limited analytics only', async () => {
    await send('put', assignment(), ownerUser()).expect(200);
    const students = [student];
    for (let index = 0; index < 4; index += 1) students.push(await account('student'));
    for (const learner of students) {
      await send('post', '/api/v1/cohorts/join', learner).send({ invite_code: first.invite_code }).expect(200);
    }
    await send('put', '/api/v1/progress/topics/' + topic.id, student).send({ completed: true }).expect(204);
    const deadlinePath = '/api/v1/cohorts/' + first.id + '/weeks/' + week.id + '/deadline';
    await send('put', deadlinePath, ownerUser()).send({ due_at: '2027-01-31T13:30:00Z', time_zone: 'UTC' }).expect(200);
    const old = await prisma.roadmapVersion.findUnique({ where: { id: initial.version_id } });
    const app = createApp({ prisma, settings });
    const newer = await send('post', organizationPath() + '/roadmaps/' + initial.id + '/versions', ownerUser())
      .send({ source_version_id: old.id, revision: old.revision }).expect(201);
    await publishRoadmap(app, newer.body.version_id, ownerUser().header);
    expect((await archiveRoadmap(app, old.id, ownerUser().header)).status).toBe(200);

    const list = await send('get', organizationPath() + '/mentor/cohorts', mentor()).expect(200);
    expect(list.body.map(({ id }) => id)).toEqual([first.id]);
    const empty = await send('get', organizationPath() + '/mentor/cohorts', staff.secondMentor).expect(200);
    expect(empty.body).toEqual([]);
    await send('get', detail(second), mentor()).expect(404);
    await send('get', detail(foreign), mentor()).expect(404);
    await send('get', '/api/v1/roadmap-versions/' + newer.body.version_id, mentor()).expect(403);
    await send('post', '/api/v1/roadmap-versions/' + newer.body.version_id + '/approve', mentor())
      .send({ revision: 1, submission_id: randomUUID() }).expect(403);
    const result = await send('get', detail() + '?roadmap_version_id=' + newer.body.version_id, mentor()).expect(200);
    expect(result.body.cohort.roadmap_version_id).toBe(old.id);
    expect(result.body.phases.flatMap((phase) => phase.weeks.flatMap((w) => w.topics.map(({ id }) => id)))).toContain(topic.id);
    expect(result.body.progress).toMatchObject({
      suppressed: false, eligible_students: 5, topics: 2, completed_topic_assignments: 1,
      possible_topic_assignments: 10, percent: 10,
    });
    expect(result.body.deadlines).toEqual([{ week_id: week.id, due_at: '2027-01-31T13:30:00.000Z', time_zone: 'UTC' }]);
    expect(JSON.stringify(result.body)).not.toMatch(/email|phone|example\.test|student_id|updated_by/);
    const staffReport = '/api/v1/cohorts/' + first.id + '/progress';
    await send('get', staffReport, mentor()).expect(403);
    const coordinatorReport = await send('get', staffReport, staff.coordinator).expect(200);
    expect(coordinatorReport.body.average_percent).toBe(10);
    const enrollment = await prisma.cohortEnrollment.findFirst({ where: { cohortId: first.id, userId: student.user.id } });
    await send('delete', '/api/v1/cohorts/' + first.id + '/enrollments/' + enrollment.id, mentor()).expect(403);
    await send('put', '/api/v1/progress/topics/' + topic.id, mentor()).send({ completed: false }).expect(403);
    await send('delete', deadlinePath, mentor()).expect(403);
    await send('post', organizationPath() + '/cohorts', mentor())
      .send({ name: 'Denied cohort', roadmap_version_id: newer.body.version_id }).expect(403);
    await send('get', organizationPath() + '/members', mentor()).expect(403);
    await send('delete', '/api/v1/cohorts/' + first.id + '/enrollments/me', student).expect(204);
    const small = await send('get', detail(), mentor()).expect(200);
    expect(small.body.progress).toMatchObject({ suppressed: true, eligible_students: null, completed_topic_assignments: null,
      possible_topic_assignments: null, percent: null, topics: 2, minimum_eligible_students: 5 });
  }, timeout);

  it('S17–S20, S23, S26–S27 retains history and revalidates role, status and session on later requests', async () => {
    const m = mentor();
    const original = await send('put', assignment(), ownerUser()).expect(200);
    const memberPath = organizationPath() + '/members/' + m.membership.id;
    await send('patch', memberPath, ownerUser()).send({ status: 'inactive' }).expect(200);
    await send('get', detail(), m).expect(403);
    await send('put', assignment(), ownerUser()).expect(409);
    await send('patch', memberPath, ownerUser()).send({ status: 'active', role: 'admin' }).expect(200);
    await send('get', detail(), m).expect(403);
    await send('patch', memberPath, ownerUser()).send({ role: 'mentor' }).expect(200);
    await prisma.user.update({ where: { id: m.user.id }, data: { status: 'suspended' } });
    await send('get', detail(), m).expect(401);
    await prisma.user.update({ where: { id: m.user.id }, data: { status: 'active' } });
    await send('delete', assignment(), ownerUser()).expect(204);
    await send('delete', assignment(), ownerUser()).expect(204);
    await send('get', detail(), m).expect(404);
    const renewed = await send('put', assignment(), ownerUser()).expect(200);
    expect(renewed.body.id).not.toBe(original.body.id);
    expect(await prisma.auditEvent.count({ where: { entityId: original.body.id, action: 'mentor_assignment.revoked' } })).toBe(1);
    const newSession = await api.post('/api/v1/auth/refresh').set('Cookie', 'outpost_refresh=' + m.refresh).expect(200);
    await send('get', detail(), m).expect(401);
    const refreshed = { header: { Authorization: 'Bearer ' + newSession.body.access_token } };
    await send('get', detail(), refreshed).expect(200);
    await send('post', '/api/v1/auth/logout', refreshed).expect(204);
    await send('get', detail(), refreshed).expect(401);
  }, timeout);
});
