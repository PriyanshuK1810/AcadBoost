# ADR-009: Roadmap Review, Approval and Publication Architecture

**Project:** Outpost V2  
**Date:** 8 November 2026  
**Status:** Accepted — Project Engineering Decision  
**Scope:** FR-07, FR-09, FR-10, FR-11, FR-12, FR-19 and RAC-02  
**Supersedes:** ADR-005's simplified three-state lifecycle where conflicting  
**Implementation status:** Design approved; T04-C through T04-F pending

## 1. Context

Outpost currently supports roadmap drafting, direct publication, archival and immutable published curriculum.

T04-A corrected unauthorized Coordinator publication. However, the system still lacks the mandatory review lifecycle required by PRD v3.0.

This ADR defines the architecture for introducing governed roadmap submission, review, rejection, publication and archival while preserving existing curriculum and student progress.

## 2. Lifecycle Decision

The supported lifecycle shall be:

```text
DRAFT
  |
  | Submit
  v
IN_REVIEW
  |
  +--- Reject with reason ---> DRAFT
  |                              |
  |                              +--- Resubmit
  |
  +--- Approve & Publish ----> PUBLISHED
                                  |
                                  | Archive
                                  v
                               ARCHIVED
```

Approval and publication occur atomically in one database transaction.

No separate `approved` state will be introduced.

Direct `draft → published` transitions are forbidden for all roles.

## 3. Permission Model

| Action | Owner | Admin | Coordinator | Mentor | Student |
|---|---|---|---|---|---|
| Create roadmap draft | Allow | Allow | Allow | Deny | Deny |
| Edit draft | Allow | Allow | Allow | Deny | Deny |
| Submit for review | Allow | Allow | Allow | Deny | Deny |
| View staff review history | Allow | Allow | Allow | Deny | Deny |
| Approve and publish | Allow | Allow | Deny | Deny | Deny |
| Reject submission | Allow | Allow | Deny | Deny | Deny |
| Archive published version | Allow | Allow | Allow | Deny | Deny |
| Copy published/archived version | Allow | Allow | Allow | Deny | Deny |

All permissions require an active organization membership, appropriate resource relationships and server-side authorization.

Owner/Admin self-approval is permitted.

There is no mandatory requirement that the submitter and reviewer be different people.

Archival remains available to Coordinators.

## 4. Review History

Each submission creates an independent `RoadmapReviewAttempt`.

The record identifies:

- The roadmap version.
- Submission identity and revision.
- Submitting user and timestamp.
- Review decision.
- Reviewing user and timestamp.
- Rejection reason when applicable.

A rejected version becomes editable again.

Resubmitting creates a new attempt without altering previous decisions.

Completed attempts are immutable through ordinary application operations. A pending attempt may be finalized exactly once.

Only one pending attempt per version is permitted.

Historical review records are retained subject to a future formally approved data-retention policy.

## 5. Rejection Policy

Every rejection requires a meaningful reason.

Rules:

- Maximum length: 2,000 characters.
- Empty or whitespace-only reasons are invalid.
- Rejection reasons are preserved with their review attempts.
- Authorized staff can view review feedback.
- Approved attempts have no rejection reason.
- Completed decisions and their reasons cannot be edited through normal application operations.

## 6. Concurrency and Integrity

Every roadmap version has an opaque revision token.

Mutating API requests must include their expected revision.

Stale requests return HTTP 409 without modifying data.

Review decisions must also identify the exact submission attempt.

PostgreSQL transactions shall protect lifecycle changes using consistent lock ordering.

A submitted version becomes read-only.

Revision advancement must cover material content and lifecycle changes without excessive per-row database writes.

The exact trigger implementation must be verified against actual source and database behavior during T04-C.

## 7. Publication Transaction

Approval and publication must perform the following atomically:

1. Validate active authorization and resource ownership.
2. Validate current submission identity and revision.
3. Finalize the review attempt as approved.
4. Set the roadmap version to `published`.
5. Record publication metadata.
6. Insert the appropriate audit event.

If any required operation fails, the entire transaction must roll back.

No legacy endpoint may bypass review.

## 8. Governance Auditing

Introduce a reusable `AuditEvent` foundation during T04-C.

Initially support:

- `roadmap.submitted`
- `roadmap.rejected`
- `roadmap.approved_published`
- `roadmap.archived`

Audit records contain actor, organization, action, entity, timestamp, request correlation information where available and bounded non-sensitive metadata.

Successful lifecycle mutations and their success audit events commit together.

Audit history is append-only through normal application operations.

Full organization-wide governance auditing remains T09's responsibility.

## 9. Archival Semantics

Archiving changes a published version's lifecycle status to `archived`.

It does not delete or rewrite curriculum.

Archived versions:

- Are unavailable for new cohort assignment.
- Remain accessible to existing authorized users.
- Preserve existing cohort pins.
- Preserve topic identities and progress.
- Remain immutable.
- Can be copied to create a new draft.

Archiving the last published version is permitted, but the frontend must warn about the effect on future cohort creation.

## 10. Historical Data Preservation

The migration must preserve existing drafts, published versions and archived versions.

It must not modify existing version identifiers, topic identifiers, cohort pins, student progress, activity history or original publication timestamps.

Previously published versions are legitimate historical records.

No fabricated review attempts or reviewer identities shall be assigned to those versions.

New publication transitions must follow the review lifecycle.

## 11. PDF Import Compatibility

PDF source review and curriculum approval are separate processes.

PDF conversion creates a normal roadmap draft.

The converted draft must follow the same submission, review, rejection and publication workflow as manually created drafts.

Existing PDF conversion idempotency must remain intact.

## 12. Migration and Deployment

Use forward-only Prisma migrations.

Do not modify previously applied migration files.

T04-C may implement and verify the strict database schema independently.

However, T04-C must not be deployed to shared or production environments before the compatible backend is ready.

T04-C and T04-D require a coordinated release, with an appropriate write pause, verified backup and migration rehearsal.

The frontend workflow must be compatible before the feature is enabled for users.

A temporary direct-publication bypass is prohibited.

Recovery must follow a documented forward-repair or validated restoration procedure. Reverting to an incompatible old backend is not an acceptable rollback strategy.

## 13. Verification Requirements

Acceptance requires real PostgreSQL verification of:

- Valid lifecycle transitions.
- Forbidden transitions.
- Submission-history integrity.
- Rejection and resubmission.
- Duplicate and concurrent decisions.
- Revision conflicts.
- Transaction rollback.
- Historical curriculum preservation.
- Existing cohort pins and progress.
- SQL-level content immutability.
- Transactional audit events.
- PDF-derived draft compatibility.
- Cross-tenant authorization in the backend phase.

A database migration passing its own tests does not establish complete FR-10 compliance.

## 14. Consequences

This design introduces additional schema, transaction and testing complexity.

It preserves accountability and historical integrity while keeping the user-facing lifecycle relatively simple.

It intentionally changes legacy direct-publication behavior.

Implementation must proceed through T04-C, T04-D, T04-E and T04-F before the full workflow is marked verified.

## 15. Remaining Implementation Decisions

The following are engineering details to verify during implementation, not authorization to change the approved product behavior:

- Exact database revision-trigger strategy.
- Precise schema field names and indexes.
- SQL constraints and deferred-check implementation.
- API DTO and error-envelope compatibility.
- Test-fixture migration strategy.
- Audit retention and future access policies.
- Deployment-specific maintenance and recovery procedures.

Any material deviation from this ADR requires review before implementation.