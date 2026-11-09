# ADR-009 — T04-C database implementation contract

The approved [ADR-009](ADR-009-roadmap-review-approval.md) is preserved verbatim in its own file. This companion records implementation details, not additional product-policy decisions. T04-D backend authorization and HTTP conflict handling, T04-E UI, and T04-F end-to-end acceptance remain pending. No institutional supervisor approval is claimed.

## Revision contract

`roadmap_versions.revision` is a positive, database-managed integer. Clients treat it as an opaque token and must not infer content identity from differences between numbers. Existing rows receive 1 without modifying their original values. A newly inserted draft starts at 1. Hierarchy construction in its creation transaction retains 1.

`revision_txid` is an internal bigint transaction marker, initialized with `txid_current()`. It is not an API token. The first material phase/week/topic insert, update or deletion in a later transaction increments the version revision and records that transaction ID. Further content mutations of that version in the same transaction reuse that revision, including full-tree replacement and cascades. No-op content updates do not advance it. The hierarchy guards still check and lock the version on each row; only the version write is coalesced. The marker is persistent transaction identity, not a session setting or caller-controlled opt-out. Direct ordinary SQL attempts to set either revision field are denied.

Every lifecycle transition increments the revision independently, even if content was edited in the same transaction. If the draft revision is R immediately before submission, `draft -> in_review` produces R+1 and the pending attempt's `submitted_revision` MUST equal R+1. The frozen content is the content present at this transition. Rejection and approval consume that exact attempt and advance to R+2. Rejection makes the draft editable; subsequent edits advance as above and resubmission allocates a new attempt. Archival increments once more, preserving publication time. Integer overflow fails safely rather than wrapping a token.

The database supports compare-and-set using `WHERE id = $id AND revision = $expected AND status = $expectedStatus`. Hierarchy mutations require a version lock followed by a revision comparison **before** writing children. HTTP requests carrying expected revisions, attempt IDs and mapping stale results to 409 belong to T04-D; they are not implemented by T04-C. One logical lifecycle action per version per transaction is the supported protocol. Flush deferred constraints only after all required statements exist; do not force them immediate between those statements.

## Transaction protocols

All operations must first check live account status, active organization, active membership and resource relationships inside the transaction. Submission/edit/archive roles: Owner/Admin/Coordinator. Decision roles: Owner/Admin. Self-approval is allowed. SQL integrity constraints do not authenticate the application actor or replace these checks.

Use this lock order: organization; roadmap when required for version allocation; all affected versions in ascending UUID order; attempts in ascending UUID order; hierarchy rows in stable parent/order/ID order. Existing route code already locks organization and version for most edits. T04-D must preserve this ordering and revalidate authorization while holding the organization lock. A decision must lock its version before updating/locking the attempt, then recheck both its expected revision and exact pending attempt identity. A child row trigger cannot retroactively change PostgreSQL's acquisition of the target row lock. Arbitrary SQL that ignores the documented order can deadlock; the database aborts a victim, and callers must retry the entire transaction after 40P01 or serialization failure. Ordered tested operations serialize without duplicate effects.

Submission, in order:

1. Lock/authorize and compare expected draft revision; update status to `in_review` and obtain the new revision with `RETURNING`.
2. Insert a pending attempt with that revision and the submitter identity.
3. Insert `roadmap.submitted` audit event.
4. Commit. Deferred constraints reject missing or mismatched attempts/events.

Decision, in order:

1. Lock/authorize and compare expected submitted revision and exact pending attempt.
2. Finalize the attempt once with reviewer, decision, reviewed timestamp and, for rejection, a meaningful reason of at most 2,000 characters.
3. Update version to `draft` on rejection, or `published` on approval. For approval, copy the exact database `reviewed_at` into `published_at`; avoid loss of PostgreSQL microseconds through JavaScript Date round-tripping.
4. Insert the matching `roadmap.rejected` or `roadmap.approved_published` event and commit.

Archival updates a published version to archived, inserts `roadmap.archived`, and commits. Original publication metadata remains unchanged. The last published version may be archived; T04-E must warn about future cohort availability. Existing cohort pins remain readable and immutable. SQL rejects new assignments to draft, in-review, archived or foreign-organization versions. Copying immutable versions still creates a normal new draft with new hierarchy IDs; T04-D preserves existing copy and PDF conversion idempotency.

## Review and audit constraints

Review attempts use restrictive FKs to version/submitter/reviewer, a unique `(version_id, submitted_revision)`, partial unique pending/approved indexes, decision/metadata CHECK constraints, immutable identity and finalize-once triggers. Completed attempts cannot be updated or deleted. Pending attempts cannot be deleted either. Historical approved/archived rows need no review and receive no invented history.

Audit events have restrictive organization/actor FKs, indexed tenant/time, actor/time and entity/time fields, and bounded action/entity/request syntax. Metadata is a flat JSON object: maximum 4,096 bytes of PostgreSQL JSON text, 16 fields, 64-character safe keys, scalar values, and string values at most 256 characters. Common secret-bearing key names are rejected. T04-D must construct an allowlisted payload from known non-sensitive values; database syntax checks cannot identify a secret disguised as an arbitrary scalar value. Do not place rejection text, credentials, tokens or invitation codes in metadata.

For the four roadmap lifecycle events use `entity_type='roadmap_version'`, exact version UUID as `entity_id`, and JSON numeric `revision`. Submission/decision events additionally require string `reviewAttemptId`. The event trigger validates tenant, current transaction, state, revision and exact attempt/actor relationship. A partial expression unique index prevents duplicate events for the same action/version/revision. Deferred version triggers require the corresponding success event before commit. Events cannot be updated or deleted. BEFORE TRUNCATE guards close the row-trigger bypass for governance and curriculum tables.

Audit emission remains the responsibility of T04-D. The migration makes old direct-publication operations fail rather than emitting guessed actors or inventing approvals. Restrictive retention FKs intentionally prevent ordinary organization/user/version deletion from erasing governance history. A formally approved future retention process is needed for exceptional removal.

## Deployment and recovery

Do not deploy this migration independently or with the old backend. There is no temporary direct-publication bypass. Release T04-C and independently reviewed T04-D together, with compatible frontend behavior before enabling users.

Before rollout: rehearse all seven migrations on a fresh database and the upgrade on a restored, representative backup; verify backup restoration, constraints, identity/pin/progress snapshots and timing. Pause all API/worker writes and drain transactions. Take a verified database backup and retain compatible application artifacts. Apply `prisma migrate deploy`, generate the matching client, deploy the compatible backend, verify lifecycle/authorization/audit/read paths, then enable the frontend workflow and resume writes. Use a separate least-privilege runtime role without schema ownership, DDL, trigger-disabling or replication privileges; migration privileges belong to deployment tooling.

The migration is explicitly transactional. Tests inject failure immediately before COMMIT, confirm no new revision column survives rollback, then apply it successfully. This tests SQL rollback/forward retry, not a production restoration exercise. If Prisma records a failed migration, inspect the database and migration history first; only after verifying complete rollback should an operator resolve that failed migration as rolled back and retry a corrected forward release. If partial external changes exist, use a reviewed forward-repair migration. If restoration is chosen, restore and validate the full backup and its compatible application version before resuming writes. Never start an incompatible old backend on the strict schema. Production backup tooling, downtime and validated restore procedures remain deployment-specific obligations.

## Verification scope

Run `node scripts/verify-roadmap-review.mjs` from `backend-js/` to reproduce the database checks. The runner creates and removes its own disposable resources and writes reports to the system temporary directory by default. Prisma schema-drift checks cover Prisma-representable schema. Separate PostgreSQL catalog assertions inspect CHECK constraints, partial indexes, FKs and deferred triggers.

Database verification does not establish cross-tenant API authorization, 409 envelopes, frontend warning/history workflows or full FR-10 compliance. Those remain T04-D through T04-F.
