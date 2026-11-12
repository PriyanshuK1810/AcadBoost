import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPrismaClient } from '../../src/db/client.js';
import { issueSession } from '../../src/modules/auth/service.js';

const source = process.env.T04D_DATABASE_URL;
describe.skipIf(!source)('T04-D historical curriculum API', () => {
  test('[historical] pre-review publication archives with an audit and preserves exact historical values', async () => {
    if (!/^\/outpost_t04c_[a-f0-9]+$/.test(new URL(source).pathname)) throw new Error('Disposable database required');
    const database = `outpost_t04c_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: source }); await admin.connect();
    let client, prisma, created = false;
    const evidence = { database, purpose: 'Disposable six-migration historical API fixture' };
    try {
      await admin.query(`CREATE DATABASE "${database}"`); created = true;
      const url = new URL(source); url.pathname = `/${database}`;
      client = new pg.Client({ connectionString: url.href }); await client.connect();
      const migrations = new URL('../../prisma/migrations/', import.meta.url);
      const names = (await readdir(migrations)).filter(n => n !== 'migration_lock.toml').sort();
      for (const name of names.slice(0, 6)) await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
      const q = async (sql, values = []) => (await client.query(sql, values)).rows;
      const [actor] = await q("INSERT INTO users(display_name,account_type) VALUES('Legacy coordinator','coordinator') RETURNING *");
      const [student] = await q("INSERT INTO users(display_name,account_type) VALUES('Legacy student','student') RETURNING *");
      const [org] = await q("INSERT INTO organizations(name,slug) VALUES('Legacy campus',$1) RETURNING *", [randomUUID()]);
      await q("INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'coordinator')", [org.id, actor.id]);
      const [roadmap] = await q("INSERT INTO roadmaps(organization_id,name,created_by) VALUES($1,'Legacy plan',$2) RETURNING *", [org.id, actor.id]);
      const [version] = await q("INSERT INTO roadmap_versions(roadmap_id,version_number,status,created_by) VALUES($1,1,'draft',$2) RETURNING *", [roadmap.id, actor.id]);
      const [phase] = await q("INSERT INTO phases(roadmap_version_id,title,order_index) VALUES($1,'Legacy phase',1) RETURNING *", [version.id]);
      const [week] = await q("INSERT INTO weeks(phase_id,title,order_index) VALUES($1,'Legacy week',1) RETURNING *", [phase.id]);
      const [topic] = await q("INSERT INTO topics(week_id,title,order_index) VALUES($1,'Legacy topic',1) RETURNING *", [week.id]);
      await q("UPDATE roadmap_versions SET status='published',published_at='2026-09-20T12:34:56.123456Z' WHERE id=$1", [version.id]);
      const [cohort] = await q("INSERT INTO cohorts(organization_id,roadmap_version_id,name,created_by) VALUES($1,$2,'Legacy class',$3) RETURNING *", [org.id, version.id, actor.id]);
      await q('INSERT INTO cohort_enrollments(cohort_id,user_id) VALUES($1,$2)', [cohort.id, student.id]);
      await q("INSERT INTO topic_progress(user_id,topic_id,status) VALUES($1,$2,'completed')", [student.id, topic.id]);
      await q("INSERT INTO activity_events(organization_id,user_id,topic_id,event_type,old_status,new_status) VALUES($1,$2,$3,'topic_completed','not_started','completed')", [org.id, student.id, topic.id]);
      const snapshot = async () => {
        const result = {};
        for (const table of ['phases', 'weeks', 'topics', 'cohorts', 'cohort_enrollments', 'topic_progress', 'activity_events']) result[table] = await q(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
        result.publication = await q('SELECT id, published_at::text, created_at::text FROM roadmap_versions WHERE id=$1', [version.id]);
        return result;
      };
      evidence.before = await snapshot();
      await client.query(await readFile(new URL('20261108_roadmap_review/migration.sql', migrations), 'utf8'));
      // The historical snapshot predates review. Run the current API with its
      // additive auth schema after exercising that historical migration path.
      await client.query(await readFile(new URL('20261113_m01b_r1_browser_auth_intents/migration.sql', migrations), 'utf8'));
      expect(await snapshot()).toEqual(evidence.before);
      prisma = createPrismaClient(url.href);
      const settings = { env: 'test', authSigningKey: randomBytes(48).toString('base64url') };
      const app = createApp({ prisma, settings });
      const user = await prisma.user.findUnique({ where: { id: actor.id } });
      const session = await issueSession(prisma, settings, user, 'test', { get: () => undefined });
      const headers = { Authorization: `Bearer ${session.access}` };
      const history = await request(app).get(`/api/v1/roadmap-versions/${version.id}/reviews`).set(headers);
      expect(history.status).toBe(200); expect(history.body).toMatchObject({ status: 'published', revision: 1, reviews: [], pending_submission: null });
      const archive = await request(app).post(`/api/v1/roadmap-versions/${version.id}/archive`).set(headers).send({ revision: 1 });
      expect(archive.status).toBe(200); expect(archive.body).toMatchObject({ status: 'archived', revision: 2 });
      expect(await prisma.roadmapReviewAttempt.count()).toBe(0);
      const events = await prisma.auditEvent.findMany(); expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorId: actor.id, organizationId: org.id, action: 'roadmap.archived', metadata: { revision: 2 } });
      evidence.after = await snapshot(); expect(evidence.after).toEqual(evidence.before);
      expect((await request(app).get(`/api/v1/roadmap-versions/${version.id}`).set(headers)).body.topics[0].id).toBe(topic.id);
    } finally {
      await prisma?.$disconnect(); await client?.end();
      if (created) { await admin.query(`DROP DATABASE "${database}"`); evidence.databaseDeleted = true; }
      await admin.end();
      if (process.env.T04D_EVIDENCE_DIR) await writeFile(resolve(process.env.T04D_EVIDENCE_DIR, 'historical-api.json'), JSON.stringify(evidence, null, 2));
    }
  }, 30000);
});
