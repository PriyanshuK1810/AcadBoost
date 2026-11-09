import { publishRoadmap, archiveRoadmap } from '../helpers/roadmapWorkflow.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createPrismaClient } from '../../src/db/client.js';
import { registerLearningRoutes } from '../../src/modules/learning/routes.js';
import { errorHandler } from '../../src/core/errors.js';
import { removeTestOrganizations } from './cleanup.js';

describe.skipIf(!(process.env.OUTPOST_DATABASE_URL || process.env.DATABASE_URL))('live cohort analytics in PostgreSQL', () => {
  test('uses pinned topics and all eligible students including zero progress with explicit denominators', async () => {
    const prisma = createPrismaClient(); const users = []; const orgs = []; const actors = new Map();
    const makeUser = async (name, accountType = 'student', status = 'active') => {
      const user = await prisma.user.create({ data: { displayName: name, accountType, status } });
      users.push(user.id); actors.set(user.id, { id: user.id, account_type: accountType }); return user;
    };
    try {
      const owner = await makeUser('Owner', 'coordinator'); const stranger = await makeUser('Stranger', 'coordinator');
      const first = await makeUser('First'); const zero = await makeUser('Zero'); const suspended = await makeUser('Suspended', 'student', 'suspended');
      const org = await prisma.organization.create({ data: { name: 'Analytics campus', slug: 'analytics-' + randomUUID() } }); orgs.push(org.id);
      await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: owner.id, role: 'owner' } });
      const app = express(); app.use(express.json());
      registerLearningRoutes(app, { prisma, settings: {}, redisClient: { eval: async () => 1 }, requireUser: (req, res, next) => { req.user = actors.get(req.get('X-Actor')); next(); } }); app.use(errorHandler);
      const as = (user) => ({ 'X-Actor': user.id });
      const roadmap = await request(app).post('/api/v1/organizations/' + org.id + '/roadmaps').set(as(owner)).send({ name: 'Pinned plan', topics: [{title:'One'}, {title:'Two'}] });
      const versionPath = '/api/v1/organizations/' + org.id + '/roadmaps/' + roadmap.body.id + '/versions';
      expect((await publishRoadmap(app, roadmap.body.version_id, as(owner))).status).toBe(200);
      const cohort = await request(app).post('/api/v1/organizations/' + org.id + '/cohorts').set(as(owner)).send({name:'Lab cohort', roadmap_version_id:roadmap.body.version_id});
      for(const user of [first, zero]) expect((await request(app).post('/api/v1/cohorts/join').set(as(user)).send({invite_code:cohort.body.invite_code})).status).toBe(200);
      await prisma.organizationMembership.create({data:{organizationId:org.id,userId:suspended.id,role:'student'}});
      await prisma.cohortEnrollment.create({data:{cohortId:cohort.body.id,userId:suspended.id}});
      const topic = roadmap.body.topics[0];
      await request(app).put('/api/v1/progress/topics/' + topic.id).set(as(first)).send({completed:true});
      const path = '/api/v1/cohorts/' + cohort.body.id + '/progress';
      let result = await request(app).get(path).set(as(owner)); expect(result.status).toBe(200);
      expect(result.body).toMatchObject({roadmap_version_id:roadmap.body.version_id, roadmap_version_number:1, average_percent:25, metrics:{eligible_students:2, topics:2, completed_topic_assignments:1, possible_topic_assignments:4}, time_scope:'all_time_current_completion'});
      expect(result.body.students).toEqual(expect.arrayContaining([expect.objectContaining({id:zero.id,completed:0,percent:0,below_average:true})]));
      expect(result.body.students.map(row=>row.id)).not.toContain(suspended.id);
      expect(result.body.topics[0]).toMatchObject({completed:1,total:2,percent:50});
      expect((await request(app).get(path).set(as(first))).status).toBe(403);
      expect((await request(app).get(path).set(as(stranger))).status).toBe(403);
      const newer = await request(app).post(versionPath).set(as(owner)).send({source_version_id:roadmap.body.version_id, revision:(await prisma.roadmapVersion.findUnique({where:{id:roadmap.body.version_id}})).revision});
      await publishRoadmap(app, newer.body.version_id, as(owner));
      await archiveRoadmap(app, roadmap.body.version_id, as(owner));
      result = await request(app).get(path).set(as(owner)); expect(result.body.roadmap_version_number).toBe(1);
      await prisma.organizationMembership.updateMany({where:{organizationId:org.id,role:'student'},data:{status:'inactive'}});
      result = await request(app).get(path).set(as(owner)); expect(result.body).toMatchObject({students:[],average_percent:0,metrics:{eligible_students:0,possible_topic_assignments:0}});
      const plan = await prisma.$queryRawUnsafe('EXPLAIN (ANALYZE, FORMAT JSON) SELECT user_id, count(*) FROM topic_progress WHERE user_id = $1::uuid AND topic_id = $2::uuid AND status = $3 GROUP BY user_id', first.id, topic.id, 'completed');
      expect(plan[0]['QUERY PLAN'][0].Plan['Node Type']).toMatch(/Aggregate/);
      console.info('Phase 17 aggregate query plan:', plan[0]['QUERY PLAN'][0].Plan['Node Type'], 'execution ms:', plan[0]['QUERY PLAN'][0]['Execution Time']);
    } finally { await removeTestOrganizations(prisma, orgs, users); await prisma.$disconnect(); }
  });
});
