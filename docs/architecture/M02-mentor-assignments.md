# M02 Mentor cohort assignments

ADR-006 reserves Mentor learning access until a persisted assignment exists. ADR-004 requires a current tenant role and resource relationship. ADR-005 and ADR-008 preserve a cohort’s immutable pinned curriculum when it is archived. ADR-009 excludes Mentors from staff review and publication. M02 extends read access through dedicated routes. Existing staff and student routes retain their authorization. [Membership](../decisions/ADR-006-organization-membership-management.md) · [Tenant authorization](../decisions/ADR-004-tenant-aware-authorization.md) · [Versioning](../decisions/ADR-005-roadmap-versioning.md) · [Deadlines](../decisions/ADR-008-activity-and-cohort-deadlines.md) · [Roadmap review](../decisions/ADR-009-roadmap-review-approval.md)

## Persistence and concurrency

One assignment row records organization, cohort, membership, assigning user and assignment time. Composite foreign keys require the cohort and membership to belong to that organization. A partial unique index permits one unrevoked row per pair. Revocation records its actor and time. Reassignment inserts a new row. Foreign keys preserve history and cannot cascade changes into curriculum or enrollments. The mutation takes the organization lock used by membership governance, checks Owner authority, then locks the relevant account rows and the caller’s session. It rechecks the session with the existing authentication eligibility helper and verifies active Owner authority and target eligibility. An identical PUT returns the live assignment without a second event. DELETE is idempotent. For concurrent PUT and DELETE, commit order determines effective state.

Use the general append-only governance audit table with `mentor_assignment.assigned` and `mentor_assignment.revoked`, entity type `mentor_cohort_assignment`, and cohort/membership IDs. The audit write commits with the assignment change. The roadmap-specific event rules continue to apply to roadmap actions.

Mentor reads check session, active account, actual active Mentor membership, organization, assignment, cohort and version ancestry in a single repeatable-read transaction. Its authorization snapshot is the boundary for an in-flight response. New requests started after a committed revocation or loss of eligibility deny access. Role change, membership deactivation and suspension make a retained assignment ineffective. Restoring eligibility makes a still-unrevoked assignment effective again. An Owner can revoke it while it is ineffective.

## API contract

| Method and path under `/api/v1` | Authorized response |
| --- | --- |
| GET `/organizations/:organizationId/mentor-assignments` | Owner management data with recorded assignments, eligible Mentor choices and active cohort choices. |
| GET `/organizations/:organizationId/cohorts/:cohortId/mentor-assignments` | The same management shape scoped to a cohort. |
| PUT or DELETE `/organizations/:organizationId/cohorts/:cohortId/mentor-assignments/:membershipId` | Owner assigns or revokes the pair. PUT 200 returns the assignment. DELETE 204. |
| GET `/organizations/:organizationId/mentor/cohorts` | Currently assigned cohorts with name, organization and exact pinned version metadata. |
| GET `/organizations/:organizationId/mentor/cohorts/:cohortId` | Assigned cohort metadata, ordered pinned curriculum, cohort-wide current progress and week deadlines. No version selector. |

Owner list responses contain `assignments`, `mentors` and `cohorts`. Each assignment has `id`, `cohort_id`, `membership_id`, `assigned_at` and, on list responses, `mentor_name`. Eligible Mentor choices have `id` and `display_name`. Cohort choices have `id` and `name`. Mentor cohort responses include `id`, `organization_id`, `name`, `roadmap_version_id`, `roadmap_name` and `roadmap_version_number`. Detail returns `cohort`, `phases`, `progress` and `deadlines`. The API uses the existing sanitized error envelope. It returns 403 for insufficient organization authority, 404 for a missing or out-of-scope relationship and 409 for an ineligible assignment target in the Owner’s organization. Successful reads use `Cache-Control: no-store`.

Aggregate progress uses active enrolled student accounts with active Student membership in the tenant. Completion counts current completed topics in the exact pin. The denominator is eligible students multiplied by pinned topics, including zero-progress learners. A minimum of **five eligible students** suppresses the student count, completed count, denominator and percentage below the threshold. The number of curriculum topics remains visible. There is no individual, per-topic, historical or identity-bearing breakdown. Deadlines expose only week ID, due time and display timezone.

## Implementation and verification

First establish failing API and schema checks. Add the migration and dedicated routes, then integrate the Mentor workspace and Owner controls. Verify the two-tenant role matrix, concurrent changes and read snapshot boundary against PostgreSQL. Rehearse fresh and restored disposable databases and compare historical records. Run full backend and frontend suites and the affected browser journeys before committing.
