# RECOVERY-DB-01 — Development database upgrade

November 9, 2026. Outpost V2 local development.

## A. Executive summary

Applied `20261108_roadmap_review` once to the approved development database after validating a fresh backup by restoration. All 27 original tables matched after the upgrade. The installed API is ready, the Vite proxy works, the live T11 probe passed, and 152 targeted tests passed on disposable resources.

## B. Original database state

The source had exactly six finished migration records. `0_baseline` recorded zero executed steps and each later row recorded one. No row was failed or rolled back.

1. `0_baseline`
2. `20260928_phase12_organization_invitations`
3. `20260929_phase14_roadmap_lifecycle`
4. `20260929_phase15_cohort_governance`
5. `20261008_phase18_activity_deadlines`
6. `20261009_activity_plans`

The source catalog lacked both version revision columns and both review and audit tables. Both Prisma preflight status calls identified `20261108_roadmap_review` as the sole pending migration. Exit 1 was expected for that state.

## C. Verified database identity

- Compose service `postgres`, container `outpost-postgres-1`, container ID `32ea4bc653727f9ebb183f9e90960adff6a354bda67a3e57fddd12454008e49c`.
- Approved Windows endpoint `127.0.0.1:5433`, database `outpost`, schema `public`, PostgreSQL 17.11, cluster system identifier `7687498008600580131`. The PostgreSQL socket query in Docker matched the TCP query through port 5433. The Docker-internal port is 5432. Windows port 5432 belongs to the separate native PostgreSQL process.
- Prisma configuration and Express settings resolved the same effective connection from `backend-js/.env`. The CLI child process was pinned to that verified target with `OUTPOST_DATABASE_URL` and `DATABASE_URL`. Credentials and full URLs were excluded from the evidence.
- Source data occupied approximately 11.7 MB. Windows C:, Windows D:, and the Docker filesystem each cleared the preflight and final storage thresholds.

## D. Git and application revision

The approved checkout was `main` at `5d576dbcfa13f0e4cf18bfd8a2410180efe5aa0f`. The pending SQL SHA-256 matched the rehearsal at `c5d36e3430eae2c8ed3b66f89d23f26f0e12f548a68937bc173d966afbfc13f3`. Prisma config SHA-256 was `7ac85c80e4a62f5b186a10a04b42292fe431f37814c5e658a92a647ef1929a8b`. The checkpoint evidence retains all seven migration hashes and the hashes of pre-existing modified and untracked files.

Reviewed both ADR-009 documents, the approved SQL and the earlier rehearsal. The API contract was available in the cleanup checkpoint at `C:\Users\priya\.codex\checkpoints\outpost-cleanup-20261109-110827-5007e640\docs\architecture\roadmap-review-api.md`. The current T04-D code and T11 worktree fix were present. The 13 T11, auth and core checks passed before deployment.

## E. Fresh backup details

- Protected file: `C:\Users\priya\.codex\checkpoints\outpost-development-upgrade-20261109-171509-2854f97e\outpost-fresh-pre-upgrade.dump`.
- PostgreSQL custom format, valid `PGDMP` header, **136,817 bytes**.
- SHA-256: `548e22324c4c2cb02e623dcb5a136a9aa54cb1ca93284567ce1fab7bb1343b36`. The Docker original, retained Windows copy and re-uploaded archive matched. The digest was checked again after testing.
- The directory restricts access to the current Windows account and SYSTEM. The source snapshot was exported after writer quiescence. `pg_dump` used the same read-only snapshot as the baseline and exited 0.
- `pg_restore --list` exited 0 with 199 entries, including all 27 original public table-data entries. A strict single-transaction restore into the previously unused `outpost_upgrade_restore_c07f0baf494a` exited 0 in 648 ms. The six original ledger records, every table fingerprint, 43 validated foreign keys with zero orphans, both cohort pins and PDF link checks matched.
- The fresh archive and the November 9 rehearsal archive are retained separately.

## F. Preflight results

| Guard | Result | Evidence |
|---|---|---|
| Explicit authorization for the exact migration and development database | PASS | RECOVERY-DB-01 authorization |
| ADRs, archived API contract, rehearsal and approved SQL reviewed | PASS | Revision and source references in this report |
| Checkout, Prisma config, approved SQL and pre-existing worktree verified | PASS | Matching preflight and immediate predeploy hashes |
| Docker Compose identity, Windows port and PostgreSQL system ID | PASS | Compose, container socket and configured TCP query agreed |
| Express and Prisma effective targets | PASS | Both resolved approved `outpost/public` through port 5433 |
| API, launcher and worker inventory | PASS | No running Outpost API or worker during preflight. The existing Vite process was standalone. |
| Database write pause and no unexpected active clients | PASS | Zero other client sessions and zero active transactions at both gates |
| Six completed migrations, exactly one pending, and expected old catalog | PASS | Read-only catalog and ledger, plus two Prisma status calls |
| Approved migration bytes and SQL operation review | PASS | SHA-256 matched. Transactional additive migration and replacement lifecycle check. |
| Storage | PASS | Windows and Docker free-space checks before backup and deploy |
| Fresh protected archive, binary integrity and catalog | PASS | ACL, header, byte count, three matching hashes and archive catalog |
| Strict restore and source baseline validation | PASS | Unused restore target, single-transaction restore and matching historical fingerprints |
| Source fingerprints and archive hash immediately before deploy | PASS | Second source snapshot matched and retained file digest was unchanged |
| T04-D, T11 and sensitive debug settings | PASS | Compatible code present, 13 tests passed and dependency debug disabled |

## G. Migration execution

From `D:\Shared Workspace\Projects\Outpost-New\backend-js`, ran `node node_modules/prisma/build/index.js migrate deploy` exactly once against the approved source. Prisma reported only `20261108_roadmap_review`. Start 2026-11-09 11:48:55.494 UTC, completion 11:48:58.752 UTC, elapsed 3.258 seconds, exit 0. The migration output reported no warnings. This was an uncontended execution.

## H. Post-migration schema state

| Check | Exit or result |
|---|---|
| `node node_modules/prisma/build/index.js migrate status` | 0, up to date |
| `node node_modules/prisma/build/index.js validate` | 0, schema valid |
| `node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | 0, no differences |
| SQL migration ledger | Seven finished rows. The new row's checksum and step count matched the approved migration. |
| Revision columns | Both non-null with approved defaults. The existing version had revision 1 and a positive transaction ID. |
| Review and audit tables | Both present, with zero rows after migration |
| SQL integrity objects | 16 scoped validated constraints, 11 valid indexes and 16 enabled user triggers, including two initially deferred constraint triggers |
| SQL function definitions | Ten installed function bodies matched the approved migration SQL |
| Foreign keys and pins | 48 validated foreign keys with zero orphans, two valid historical pins |

Catalog definitions are retained for comparison. The lifecycle check and trigger, index and constraint inventory matched the rehearsed result. This covers the four states, positive revisions, unique pending submissions, review immutability, append-only audit, transactional audit requirements, curriculum and tenant guards, and cohort pin protections. The targeted suite exercised these protections with writes on disposable resources. The source version heap identifier was unchanged.

## I. Historical data preservation

For every original public base table, read the same original columns in a consistent read-only snapshot, rendered rows as JSONB in UTC, sorted with the C collation, and compared counts and keyed HMAC-SHA256 fingerprints. The new revision columns and newly appended ledger row were excluded from the original-value comparison and validated separately. Exact original column lists are in `upgrade-evidence.json`.

| Entity | Before | After | Fingerprint match | Result |
|---|---:|---:|---|---|
| `_prisma_migrations` | 6 | 6 | Yes | Matched |
| `activity_events` | 0 | 0 | Yes | Matched empty population |
| `activity_plans` | 2 | 2 | Yes | Matched |
| `alembic_version` | 1 | 1 | Yes | Matched |
| `auth_sessions` | 27 | 27 | Yes | Matched |
| `cohort_enrollments` | 1 | 1 | Yes | Matched |
| `cohort_week_deadlines` | 0 | 0 | Yes | Matched empty population |
| `cohorts` | 2 | 2 | Yes | Matched |
| `deadline_changes` | 0 | 0 | Yes | Matched empty population |
| `email_verification_tokens` | 2 | 2 | Yes | Matched |
| `oauth_identities` | 0 | 0 | Yes | Matched empty population |
| `organization_invitations` | 2 | 2 | Yes | Matched |
| `organization_memberships` | 5 | 5 | Yes | Matched |
| `organizations` | 4 | 4 | Yes | Matched |
| `otp_challenges` | 0 | 0 | Yes | Matched empty population |
| `password_credentials` | 3 | 3 | Yes | Matched |
| `password_reset_tokens` | 0 | 0 | Yes | Matched empty population |
| `phases` | 1 | 1 | Yes | Matched |
| `phone_identities` | 0 | 0 | Yes | Matched empty population |
| `review_topic_progress` | 0 | 0 | Yes | Matched empty population |
| `roadmap_versions` | 1 | 1 | Yes | Matched |
| `roadmaps` | 1 | 1 | Yes | Matched |
| `security_events` | 465 | 465 | Yes | Matched |
| `topic_progress` | 0 | 0 | Yes | Matched empty population |
| `topics` | 1 | 1 | Yes | Matched |
| `users` | 6 | 6 | Yes | Matched |
| `versions:archived` | 0 | 0 | Yes | Matched empty population |
| `versions:draft` | 0 | 0 | Yes | Matched empty population |
| `versions:in_review` | 0 | 0 | Yes | Matched empty population |
| `versions:published` | 1 | 1 | Yes | Matched |
| `weeks` | 1 | 1 | Yes | Matched |

The existing published version ID and publication timestamp matched, along with every phase, week and topic identity. There were no existing archived versions, progress rows, or activity events. Both existing cohorts and the enrollment matched. The two PDF plans remained ready and unconverted with zero incompatible links. Authentication, organization, governance and invitation records matched. The upgrade fabricated no historical review or audit rows.

## J. Backend startup verification

Port 8000 was free after the integrity checks. The generated Prisma client queried the upgraded source in a read-only transaction and needed no regeneration. Started the backend's supported `node src/server.js` entry point bound to `127.0.0.1:8000` with DEBUG and NODE_DEBUG disabled. API PID `18764` was ready and its startup and request logs showed no P2022, SQLSTATE 42703, worker failures or unexpected internal errors.

The original Vite process had exited by the time the API was ready. Started the supported `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` command and confirmed the frontend and proxy. The first shell redirection produced empty API log files, so the API was restarted with direct child-process log handles and the smoke probe was rerun. The API and Vite were left running.

## K. Local API smoke tests

| Endpoint or workflow | Expected | Actual | HTTP status | Result |
|---|---|---|---:|---|
| `GET /ready` | Backend ready | Ready | 200 | PASS |
| `GET http://localhost:5173/` | Frontend serves HTML | HTML served | 200 | PASS |
| Vite `GET /api/v1` | Proxied API metadata | Expected API metadata | 200 | PASS |
| Organization, roadmap, version, review, cohort and student endpoints without a session | Controlled authentication denial | All six denied with `unauthorized` | 401 | PASS |
| Same development routes with authentication | Synthetic authorized session | No development credentials or synthetic development account used | — | NOT_RUN |
| Real development source reads through installed Prisma | Existing organizations, versions, pinned curriculum, progress and review schema readable | Four organizations, one roadmap and version, two cohorts, intact pins, empty progress/activity and review/audit tables | — | PASS |
| Authenticated reads and review workflow on disposable fixtures | Scoped roadmap/review, cohort and progress access | Maintained PostgreSQL/API tests passed | Varies by case | PASS |
| Malformed login via Vite | Safe `invalid_json` | Safe correlated envelope | 400 | PASS |

## L. T11 security regression

Sent a synthetic malformed password payload through the live Vite proxy. Response status was 400 and the exact public error envelope matched the supplied request ID. The actual backend failure and completion logs carried the same ID. The synthetic marker was absent from the response, stdout and stderr. The malformed request failed in middleware before authentication.

## M. Automated test results

| Suite | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|
| T11, auth and core preflight (3 files) | 13 | 0 | 0 | 0 |
| Targeted database and API regression (12 files, includes the above) | 152 | 0 | 0 | 0 |

The targeted run covered maintained T04-C SQL, T04-D API and legacy archive tests, authorization, organizations, cohort governance, live analytics and student progress, PDF conversion, roadmap lifecycle, T11, auth and core. `migrate deploy` against the disposable database exited 0. The targeted Vitest run used `--maxWorkers=1 --no-cache` and exited 0. Exact command arguments and timings are in `targeted-evidence.json`.

## N. Remaining defects

| ID | Priority | Problem | Root cause | Evidence | Recommended next action |
|---|---|---|---|---|---|
| T04-E | Separate task | Frontend approval workflow acceptance outstanding | Frontend workflow is separately scoped | This task verified frontend serving and proxy, and did not implement workflow changes | Complete and verify T04-E separately |
| T04-F | Separate task | Full browser workflow verification outstanding | Browser acceptance is separately scoped | Bounded HTTP and automated checks only | Complete browser acceptance after T04-E |
| T11 diagnostic configuration | Conditional | Opt-in dependency debug logs can include query or Content-Type values | Express dependency diagnostics bypass application log formatting | T11 reviewer reproduction; debug was disabled in this run | Keep sensitive debug namespaces disabled |

The missing-revision defect is resolved on the upgraded development schema. No unexpected HTTP 500 was observed in the live smoke.

## O. Resource cleanup and preservation

The fresh archive, rehearsal archive and protected verification logs remain available. The restored verification database and Docker archive copies in `/tmp/outpost-upgrade.XXFbEaGK` were removed after successful checks. The targeted harness removed its disposable database `outpost_t04c_7fc77b806dd6` and disposable MinIO bucket `outpost-recovery-7fc77b806dd6`. The maintained historical test cleaned up its own disposable database. Existing Compose services, volumes and MinIO objects were preserved. The development API and Vite listeners remain available.

Evidence directory: `C:\Users\priya\.codex\checkpoints\outpost-development-upgrade-20261109-171509-2854f97e`. It includes `upgrade-evidence.json`, `live-smoke.json`, `api-process.json`, API and Vite logs, and targeted test results.

## P. Git state after execution

HEAD and branch are unchanged. The index is empty and `git diff --check` passed. The preflight and immediate post-migration worktree hashes matched. A later worktree check detected changes to the already modified `RoadmapVersionsPage.jsx` and `RoadmapVersions.test.jsx` during application verification. These edits were outside this task and were left in place. This task added only this report within the repository. No staging, commit or push was performed.

## Q. Recovery and backup instructions

Use the fresh protected pre-upgrade archive. Verify its SHA-256 and catalog, pause writers and preserve the current database for diagnosis. Restore to a new, unused database on a verified PostgreSQL 17 cluster using `pg_restore --exit-on-error --single-transaction --dbname=<verified-disposable-target> <archive>`. Validate the six completed migrations, table counts, original column definitions, foreign keys and cohort pins against the pre-upgrade evidence. The HMAC key was ephemeral, so the saved fingerprints prove equality during this run. If a later recovery needs a new row-for-row comparison, compare an independently restored copy of the retained archive with the proposed recovery target using a new common key. Match the application revision to the restored six-migration schema. Keep the MinIO objects and their database references together. Investigate schema and ledger state before any forward repair or retry. Restoration over `outpost` requires a separate recovery decision.

## R. Final verdict

**DEVELOPMENT DATABASE UPGRADE VERIFIED**
