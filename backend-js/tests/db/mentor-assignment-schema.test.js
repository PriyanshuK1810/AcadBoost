import { describe, expect, test } from 'vitest';
import { createPrismaClient } from '../../src/db/client.js';

const databaseUrl = process.env.M02_TEST_DATABASE_URL;

async function disposableClient() {
  const target = new URL(databaseUrl.replace(/^postgresql\+psycopg:/, 'postgresql:'));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' ||
      target.port !== '5433' || !/^\/outpost_m02_[a-z0-9_]+$/.test(target.pathname)) {
    throw new Error('M02_TEST_DATABASE_URL must point to a uniquely named outpost_m02_ database');
  }
  const expectedDatabase = target.pathname.slice(1);
  const prisma = createPrismaClient(target.href);
  const [row] = await prisma.$queryRaw`SELECT current_database() AS name`;
  if (row.name !== expectedDatabase) {
    await prisma.$disconnect();
    throw new Error(`M02 test target mismatch: expected ${expectedDatabase}, connected to ${row.name}`);
  }
  return prisma;
}

describe.skipIf(!databaseUrl)('mentor cohort assignment constraints', () => {
  test('defines the active-only unique index', async () => {
    const prisma = await disposableClient();
    try {
      const result = await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_mentor_cohort_assignments_active'`;
      expect(result).toHaveLength(1);
      expect(result[0].indexdef).toMatch(/UNIQUE INDEX.*\(cohort_id, membership_id\).*WHERE \(revoked_at IS NULL\)/i);
    } finally { await prisma.$disconnect(); }
  });

  test('enforces tenant-scoped foreign keys, active uniqueness, and paired revocation', async () => {
    const prisma = await disposableClient();
    const rollback = new Error('rollback mentor assignment fixture');
    const id = () => crypto.randomUUID();
    try {
      await expect(prisma.$transaction(async (tx) => {
        const [org1, org2, user1, user2, roadmap1, roadmap2, version1, version2, cohort1, cohort2, member1, member2] = Array.from({ length: 12 }, id);
        for (const [userId, name] of [[user1, 'M02 actor one'], [user2, 'M02 actor two']]) {
          await tx.$executeRawUnsafe('INSERT INTO users (id, display_name) VALUES ($1::uuid, $2)', userId, name);
        }
        for (const [orgId, suffix] of [[org1, 'one'], [org2, 'two']]) {
          await tx.$executeRawUnsafe('INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, $2, $3)', orgId, `M02 org ${suffix}`, `m02-${suffix}-${orgId}`);
        }
        for (const [roadmapId, orgId, userId, versionId, cohortId, suffix] of [[roadmap1, org1, user1, version1, cohort1, 'one'], [roadmap2, org2, user2, version2, cohort2, 'two']]) {
          await tx.$executeRawUnsafe('INSERT INTO roadmaps (id, organization_id, name, created_by) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)', roadmapId, orgId, `M02 roadmap ${suffix}`, userId);
          await tx.$executeRawUnsafe("INSERT INTO roadmap_versions (id, roadmap_id, version_number, status, created_by) VALUES ($1::uuid, $2::uuid, 1, 'draft', $3::uuid)", versionId, roadmapId, userId);
          const phaseId = id(), weekId = id();
          await tx.$executeRawUnsafe('INSERT INTO phases (id, roadmap_version_id, title, order_index) VALUES ($1::uuid, $2::uuid, $3, 1)', phaseId, versionId, `M02 phase ${suffix}`);
          await tx.$executeRawUnsafe('INSERT INTO weeks (id, phase_id, title, order_index) VALUES ($1::uuid, $2::uuid, $3, 1)', weekId, phaseId, `M02 week ${suffix}`);
          await tx.$executeRawUnsafe('INSERT INTO topics (id, week_id, title, order_index) VALUES ($1::uuid, $2::uuid, $3, 1)', id(), weekId, `M02 topic ${suffix}`);
          await tx.$executeRawUnsafe("UPDATE roadmap_versions SET status = 'in_review' WHERE id = $1::uuid", versionId);
          await tx.$executeRawUnsafe("UPDATE roadmap_versions SET status = 'published', published_at = now() WHERE id = $1::uuid", versionId);
          await tx.$executeRawUnsafe("INSERT INTO cohorts (id, organization_id, roadmap_version_id, name, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)", cohortId, orgId, versionId, `M02 cohort ${suffix}`, userId);
        }
        await tx.$executeRawUnsafe("INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, 'mentor'), ($4::uuid, $5::uuid, $6::uuid, 'mentor')", member1, org1, user1, member2, org2, user2);

        await tx.$executeRaw`SAVEPOINT wrong_membership_tenant`;
        await expect(tx.$executeRawUnsafe('INSERT INTO mentor_cohort_assignments (organization_id, cohort_id, membership_id, assigned_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)', org1, cohort1, member2, user1)).rejects.toThrow('fk_mentor_cohort_assignments_membership_organization');
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT wrong_membership_tenant`;
        await tx.$executeRaw`SAVEPOINT wrong_cohort_tenant`;
        await expect(tx.$executeRawUnsafe('INSERT INTO mentor_cohort_assignments (organization_id, cohort_id, membership_id, assigned_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)', org1, cohort2, member1, user1)).rejects.toThrow('fk_mentor_cohort_assignments_cohort_organization');
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT wrong_cohort_tenant`;

        const [assignment] = await tx.$queryRaw`INSERT INTO mentor_cohort_assignments (organization_id, cohort_id, membership_id, assigned_by) VALUES (${org1}::uuid, ${cohort1}::uuid, ${member1}::uuid, ${user1}::uuid) RETURNING id`;
        await tx.$executeRaw`SAVEPOINT duplicate_active`;
        await expect(tx.$executeRawUnsafe('INSERT INTO mentor_cohort_assignments (organization_id, cohort_id, membership_id, assigned_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)', org1, cohort1, member1, user1)).rejects.toThrow('uq_mentor_cohort_assignments_active');
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT duplicate_active`;
        await tx.$executeRawUnsafe('UPDATE mentor_cohort_assignments SET revoked_at = now(), revoked_by = $1::uuid WHERE id = $2::uuid', user1, assignment.id);
        const [reassignment] = await tx.$queryRaw`INSERT INTO mentor_cohort_assignments (organization_id, cohort_id, membership_id, assigned_by) VALUES (${org1}::uuid, ${cohort1}::uuid, ${member1}::uuid, ${user1}::uuid) RETURNING id`;
        expect(reassignment.id).not.toBe(assignment.id);

        await tx.$executeRaw`SAVEPOINT unmatched_revoker`;
        await expect(tx.$executeRawUnsafe('UPDATE mentor_cohort_assignments SET revoked_by = $1::uuid WHERE id = $2::uuid', user1, reassignment.id)).rejects.toThrow('ck_mentor_cohort_assignments_revocation_pair');
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT unmatched_revoker`;
        throw rollback;
      }, { timeout: 30_000 })).rejects.toBe(rollback);
    } finally { await prisma.$disconnect(); }
  });
});
