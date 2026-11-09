import { AppError, conflict, unauthorized } from '../../core/errors.js';
import { requireOrganizationRole } from '../../core/authorization.js';

const editors = Object.freeze(['owner', 'admin', 'coordinator']);
const reviewers = Object.freeze(['owner', 'admin']);
export const ROADMAP_ACTION_ROLES = Object.freeze({
  create: editors, edit: editors, submit: editors, reviews: editors,
  approve: reviewers, reject: reviewers, archive: editors, copy: editors,
});

export async function authorizeRoadmap(db, request, organizationId, action, lock = false) {
  // Fail closed on tenant/role before querying additional actor information.
  await requireOrganizationRole(db, request.user, organizationId, ROADMAP_ACTION_ROLES[action]);
  if (lock) {
    // Auth refresh/revocation already lock user before session. Keep that order.
    await db.$queryRaw`SELECT id FROM users WHERE id = ${request.user.id}::uuid FOR SHARE`;
    if (request.authSession) {
      await db.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${request.authSession.id}::uuid FOR SHARE`;
    }
    await db.$queryRaw`SELECT id FROM organization_memberships
      WHERE organization_id = ${organizationId}::uuid AND user_id = ${request.user.id}::uuid FOR SHARE`;
  }
  const user = await db.user.findUnique({ where: { id: request.user.id } });
  if (!user || user.status !== 'active') throw unauthorized('Invalid or expired access credential');
  if (request.authSession) {
    const session = await db.authSession.findUnique({ where: { id: request.authSession.id } });
    if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt <= new Date()) {
      throw unauthorized('Invalid or expired access credential');
    }
  }
  return requireOrganizationRole(db, { id: user.id, account_type: user.accountType }, organizationId, ROADMAP_ACTION_ROLES[action]);
}

export function assertRevision(version, revision) {
  if (version.revision !== revision) throw conflict('This version changed. Reload before continuing.');
}

export async function roadmapTransaction(prisma, request, operation, options = {}) {
  try {
    return await prisma.$transaction(operation, { timeout: 30_000, ...options });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const sqlState = error.meta?.code || error.meta?.driverAdapterError?.cause?.originalCode;
    if (error.code === 'P2034' || ['40001', '40P01'].includes(sqlState)) {
      throw conflict('A concurrent operation changed this resource. Reload and retry.');
    }
    // Never log SQL parameters, reasons, credentials or the full curriculum.
    console.error('roadmap.transaction_failed', { requestId: request.requestId, code: error.code, sqlState });
    throw new AppError(500, 'internal_error', 'Internal server error');
  }
}

export async function lifecycleAudit(tx, request, roadmap, version, action, attempt) {
  // Construct the entire metadata object here; never merge request data.
  const metadata = { revision: version.revision };
  if (attempt) metadata.reviewAttemptId = attempt.id;
  await tx.auditEvent.create({ data: {
    organizationId: roadmap.organizationId, actorId: request.user.id, action,
    entityType: 'roadmap_version', entityId: version.id,
    requestId: request.requestId || null, metadata,
  } });
}

export async function submitVersion(tx, request, roadmap, version, revision) {
  if (version.status !== 'draft') throw conflict('Only draft versions can be submitted');
  assertRevision(version, revision);
  const submitted = await tx.roadmapVersion.update({ where: { id: version.id }, data: { status: 'in_review' } });
  const attempt = await tx.roadmapReviewAttempt.create({ data: {
    versionId: version.id, submittedRevision: submitted.revision, submittedBy: request.user.id,
  } });
  await lifecycleAudit(tx, request, roadmap, submitted, 'roadmap.submitted', attempt);
  return submitted;
}

export async function decideVersion(tx, request, roadmap, version, input, decision) {
  if (version.status !== 'in_review') throw conflict('Only in-review versions can be decided');
  assertRevision(version, input.revision);
  // Version is already locked. Lock/check only the exact scoped attempt next.
  await tx.$queryRaw`SELECT id FROM roadmap_review_attempts
    WHERE id = ${input.submission_id}::uuid AND version_id = ${version.id}::uuid FOR UPDATE`;
  const attempt = await tx.roadmapReviewAttempt.findUnique({ where: { id: input.submission_id } });
  if (!attempt || attempt.versionId !== version.id || attempt.decision !== 'pending' ||
      attempt.submittedRevision !== version.revision) throw conflict('The pending submission changed. Reload before reviewing.');
  await tx.$executeRaw`UPDATE roadmap_review_attempts SET decision = ${decision},
    reviewed_by = ${request.user.id}::uuid, reviewed_at = clock_timestamp(),
    rejection_reason = ${decision === 'rejected' ? input.reason : null}
    WHERE id = ${attempt.id}::uuid`;
  if (decision === 'approved') {
    // PostgreSQL retains microseconds; JavaScript Date would truncate them.
    await tx.$executeRaw`UPDATE roadmap_versions SET status = 'published',
      published_at = (SELECT reviewed_at FROM roadmap_review_attempts WHERE id = ${attempt.id}::uuid)
      WHERE id = ${version.id}::uuid`;
  } else {
    await tx.roadmapVersion.update({ where: { id: version.id }, data: { status: 'draft' } });
  }
  const updated = await tx.roadmapVersion.findUnique({ where: { id: version.id } });
  await lifecycleAudit(tx, request, roadmap, updated,
    decision === 'approved' ? 'roadmap.approved_published' : 'roadmap.rejected', attempt);
  return updated;
}

export const reviewSelect = Object.freeze({
  id: true, versionId: true, submittedRevision: true, submittedAt: true,
  decision: true, reviewedAt: true, rejectionReason: true,
  submitter: { select: { id: true, displayName: true } },
  reviewer: { select: { id: true, displayName: true } },
});
export function reviewOutput(attempt) {
  if (!attempt) return null;
  const identity = user => user ? { id: user.id, display_name: user.displayName } : null;
  return { id: attempt.id, version_id: attempt.versionId, submitted_revision: attempt.submittedRevision,
    submitted_at: attempt.submittedAt, submitted_by: identity(attempt.submitter), decision: attempt.decision,
    reviewed_at: attempt.reviewedAt, reviewed_by: identity(attempt.reviewer), rejection_reason: attempt.rejectionReason };
}
