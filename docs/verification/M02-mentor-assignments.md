# M02 Mentor assignment verification

**Verdict** M02 IMPLEMENTATION VERIFIED — DEV MIGRATION PENDING

**Starting revision** `19677d6a73ea1f82373a65fe1fd741657b1317ef` on `main`, with a clean working tree. PostgreSQL 17.11 development began at eight applied Prisma migrations, ending in `20261113_m01b_r1_browser_auth_intents`.

## Product policy and architecture

ADR-003 remains the session and revocation contract. ADR-004 and ADR-006 require active tenant roles and resource-specific authorization. ADR-006 explicitly makes a persisted assignment a prerequisite for Mentor learning access. ADR-005 and ADR-008 keep an archived version available through its existing cohort pin. ADR-007 governs enrollment, and ADR-009 continues to govern curriculum review and publication. Existing staff route permissions are retained. [Architecture and complete API contracts](../architecture/M02-mentor-assignments.md)

| Role in the current organization | Assignment management | Dedicated Mentor learning reads |
| --- | --- | --- |
| Active Owner | List, assign, revoke | Existing staff routes remain available |
| Admin and Coordinator | Denied | Existing staff routes remain available |
| Active Mentor with a current assignment | Denied | Assigned active cohorts and their exact pinned curriculum, cohort aggregates and deadlines |
| Active Mentor without a current assignment | Denied | Empty list, detail denied |
| Student | Denied | Existing enrolled Student routes remain available |
| Inactive membership, incompatible role or suspended account | Denied as applicable | Denied as applicable |

An unrevoked assignment becomes ineffective while the membership, role, account or cohort is ineligible. Restored eligibility makes that assignment effective again. Explicit revocation ends that assignment permanently, and a later PUT creates a distinct history row. The privacy minimum is five eligible students. Below that, the API suppresses enrollment count and all completion metrics. Curriculum and deadline fields remain readable. Individual learning records, contact fields and staff audit data are absent from the Mentor response.

## Database rehearsal

`20261113_m02_mentor_cohort_assignments` adds `MentorCohortAssignment`, restrictive composite foreign keys to the same-organization cohort and membership, restrictive actor foreign keys, an active-only unique index, lookup indexes and paired revocation fields. The assigning and revoking actor and the applicable timestamps are persisted. Audit events commit with the assignment or revocation in the existing governance audit table.

Migration SHA-256 `a2dce6fe58f3bacb3d3d829700e6e07f25371886e2dcf7f597010835a345c868`.

- A fresh, uniquely named disposable PostgreSQL database applied all nine migrations. Prisma schema validation and client generation succeeded.
- A protected read-only development snapshot was restored with `--exit-on-error --single-transaction` to a verified empty disposable database. Its 31 public tables matched the source row counts and sorted row hashes. After deploying M02 there, all 30 historical application tables retained their pre-migration counts and hashes. The first eight ledger rows retained their migration names, checksums and successful states. M02 was the ninth successful migration, and the new assignment table was empty.
- Real PostgreSQL assertions exercise both cross-tenant foreign keys, active-only uniqueness, reassignment history and the paired-revocation constraint.

### Development database incident

A subagent invoked the existing `test:db` wrapper while `.env` pointed to development. Its hard-coded DB suite selection may have run existing write-producing fixtures. The subagent also ran a first restore with `--create`; it attempted to create `outpost`, which already existed, and reported 251 errors. Subsequent rehearsals used explicit disposable targets and fail-fast restores.

Read-only comparison of the earlier archive with the current development database found additional rows in 19 tables, including 340 users, 338 memberships, 79 organizations, 75 sessions and 41 audit events. All earlier archive rows remained present and identical. The additional users were created during an 88-second window after the archive. The existing test wrapper is the likely source. A schema-only comparison found differences in how PostgreSQL renders casts in seven checks and one index predicate. The predicates had the same expressions after accounting for the cast rendering. Attribution of every addition and database-level metadata effects from the first restore remain unverified. The development database retains eight applied migrations and has no Mentor assignment table. Both archives and the comparison evidence were preserved locally. Development cleanup requires a separate recovery decision.

## Acceptance matrix

All 30 cases passed on the focused PostgreSQL, React and Edge runs listed below.

| Case | Evidence |
| --- | --- |
| M02-S01 | Owner PUT returns the active assignment and records the assignment audit event. |
| M02-S02 | Admin PUT and DELETE denied. |
| M02-S03 | Coordinator PUT and DELETE denied. |
| M02-S04 | Student PUT and DELETE denied. |
| M02-S05 | Mentor self-assignment and revocation denied. |
| M02-S06 | Foreign membership returns scoped 404. The composite FK rejects a direct forged link. |
| M02-S07 | Foreign cohort returns scoped 404. The composite FK rejects a direct forged link. |
| M02-S08 | Two active Owner sessions obtain the same assignment, with one audit event. A retry returns the same ID. |
| M02-S09 | The Mentor list contains only the assigned cohort. |
| M02-S10 | Same-organization unassigned and foreign detail requests return 404. |
| M02-S11 | The direct version route denies access. A forged query parameter cannot change the pin. |
| M02-S12 | Detail returns the original immutable pin after a newer version is published and the original is archived. |
| M02-S13 | The payload contains no contact or student identity fields. The individual staff report and directory are denied. |
| M02-S14 | Mentor enrollment removal denied. |
| M02-S15 | Mentor topic progress mutation denied. |
| M02-S16 | Mentor deadline removal denied. |
| M02-S17 | Revocation is audited once. Later reads return 404. |
| M02-S18 | Membership deactivation blocks subsequent reads and assignment. |
| M02-S19 | An active membership changed from Mentor to Admin loses Mentor-route access. |
| M02-S20 | Account suspension blocks authentication for subsequent reads. |
| M02-S21 | With deactivation first, PUT returns 409. With assignment first, subsequent reads return 403 after deactivation. |
| M02-S22 | An earlier repeatable-read snapshot returns its authorized response, and a request started after revocation returns 404. |
| M02-S23 | Revoked assignment stays in history. Revoke followed by PUT creates a distinct ID, and PUT followed by revoke ends access. |
| M02-S24 | Student joins, records topic completion and withdraws through existing APIs. |
| M02-S25 | Coordinator report retains the expected percentage and staff permissions. |
| M02-S26 | Owner membership governance and cohort setup remain available. |
| M02-S27 | Refresh rotates the session. The old access token and the logged-out replacement are rejected. An Owner mutation waiting for the organization lock is rejected if its session is revoked first. |
| M02-S28 | Edge switches the same account from Mentor in one organization to Coordinator in another and back. React tests discard late responses from the previous scope. |
| M02-S29 | Unassigned API returns an empty list. The Mentor workspace renders the corresponding empty state. |
| M02-S30 | Four eligible learners suppress all enrollment-derived metrics. Five eligible learners return the approved aggregate. |

Mutations acquire the organization lock used by membership governance. Session and assignment eligibility are checked inside that transaction after relevant account and session rows are locked. Audit and mutation state become visible at commit. Mentor reads use one PostgreSQL repeatable-read snapshot for live session, membership, assignment, cohort, pin and data. The race test establishes a read snapshot, commits a revocation on another connection, and then releases the original transaction to read its earlier state. A completed revocation excludes fresh snapshots.

## Verification runs

- Focused backend passed 14 tests across three files after review. The tests cover two-tenant HTTP behavior, database constraints, both mutation race orders, read snapshot behavior and revoked Owner sessions.
- Focused frontend passed 35 tests across the Mentor workspace, workspace shell and organization detail, including refreshing eligible Mentors after membership changes.
- Full frontend passed 301 tests across 23 files with zero failures or skips on the bundled Node runtime. Earlier runs encountered worker startup timeouts and an intermittent phone-input focus assertion. The unchanged auth test and full frontend suite passed on rerun.
- Full backend passed 324 tests across 40 files with zero failures or skips on the final isolated run. The initial isolated run passed 322 with one timeout in the existing auth process-restart case. That case passed on the final run.
- Microsoft Edge passed the end-to-end Owner assign and revoke journey and the Mentor empty state, assigned-only list, pinned curriculum, suppressed progress, deadline display and organization/role switching. The Mentor journey used a mobile-sized viewport and keyboard activation to recheck access after revocation.
- Frontend lint and production build passed. Vite reported its 500 kB chunk-size warning.
- Prisma validation and Git whitespace checks passed.

The browser journey is runnable from `frontend` with `node tests/e2e/mentor-assignments.mjs`. Set `M02_TEST_DATABASE_URL` to a migrated disposable `outpost_m02_` database on the local PostgreSQL endpoint. Set `M02_BROWSER` and `M02_OPENSSL` when the Chromium executable and OpenSSL require explicit paths. The fixture creates synthetic users and curriculum in the disposable database.

## Scope and manual migration

Changed backend paths are the Prisma schema and migration, `learning/routes.js`, dedicated `learning/mentorRoutes.js` and three Mentor test files. Frontend changes are the shared learning API adapter, workspace shell, Owner organization details, dedicated Mentor workspace and Owner assignment components, React tests and the Playwright journey. Architecture and verification are recorded in these two M02 documents.

Mentor progress is a current cohort snapshot. The minimum-size rule suppresses small-cohort values and the API exposes no historical series or individual breakdown. A Mentor comparing eligible aggregates across requests may still infer changes to totals. An already displayed result remains visible until the workspace changes scope or requests the detail again. The server checks access on each request.

After reviewing the development database incident and deciding when to deploy, run this manually. The Prisma configuration resolves the backend environment. Verify its database target is the intended development instance before executing.

```powershell
Set-Location 'D:\Shared Workspace\Projects\Outpost-New\backend-js'
node node_modules/prisma/build/index.js migrate deploy
```
