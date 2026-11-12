# M01B-R1 server-session fencing verification

## A. Executive summary

The R1 patch moves Google session supersession to PostgreSQL. In the simulated-provider HTTPS tests, the browser accepted the Google refresh cookie before losing the activation response body or closing the initiating tab. A newer password submission still returned 401 for invalid credentials. The old refresh cookie and bearer then both returned 401, the exact family was revoked, and the unrelated control session remained usable.

All 31 local acceptance cases and both full suites passed. Development migration and real-provider acceptance remain separate gates.

## B. Git and working-tree state

The implementation started at `2f7df3efce4c46217d155657b3bf7dc0fe0c6ff9` on `main`, with an empty index, 13 tracked changes and eight untracked files from M01B and its architecture work. The preflight ran the requested status, HEAD, branch, diff check, diff stat and untracked inventory. The [R1 specification](../architecture/M01B-R1-server-session-fencing-specification.md#source-inventory) records the original M01B paths. The R1 specification itself was the eighth untracked file.

## C. Root cause and corrected security invariant

The earlier Google activation wrote the refresh cookie before React received its bearer. A failed newer sign-in changed only client intent state, and client compensation required that missing bearer. R1 makes the newer intent authoritative at the PostgreSQL commit that advances its browser context and fences the earlier family. Subsequent refresh or protected bearer authorization uses live database eligibility. A previously authorized in-flight request can finish. [Original M01B verification](M01B-google-react-handoff.md#h-race-condition-verification)

## D. Schema and migration

`20261113_m01b_r1_browser_auth_intents` adds the browser context and intent tables, their expiry and state constraints, and an optional session link. A composite foreign key ties the linked row to the exact intent, family and owner with `MATCH SIMPLE` and `RESTRICT` update/delete. A NULL link preserves legacy rows. The migration adds no application data and performs no historical backfill.

Migration SHA-256 `2e63e01d1f73cbd7f52b55a8bd764132295cb5d523ec0f556e0fcbc77002fcbb`.

## E. Transaction and lock-order implementation

Intent advancement locks the context, then applicable user rows in UUID order, and writes the generation, new intent, receipt tombstone and exact-family revocation together. Google activation locks the context, takes subject/email advisory locks and the linked user lock where applicable, and commits the receipt, session and auth event together. Password hashing is outside the intent transaction. Phone challenge locking precedes any user lock in the issuance transaction.

Rotation uses the existing user lock and rereads the session and receipt after taking it. It never locks the browser context. The tested rotation-first schedule blocked fencing on that user row and revoked the successor after rotation committed. The fence-first schedule rejected the predecessor without creating a successor.

## F. Browser binding and intent generation

The server issues a 32-byte proof in `__Host-outpost_auth_context` with Secure, HttpOnly, Strict, Path=/ and no Domain. It persists a SHA-256 digest and an absolute 90-day deadline. The bootstrap is guarded by exact Origin and the request marker. The reset branch clears only invalid or expired context proof. Bound actions use a per-context idempotency UUID and PostgreSQL-owned BIGINT. Bootstrap is limited to 10 per minute per observed peer and accepted actions to 30 per minute per context. The canonical ingress still needs verified client-address handling.

## G. Exact family receipt and revocation

The receipt binds the server generation, Google attempt, owner and exact ADR-003 family. Rotation propagates the link. Fenced session eligibility requires the original proof, active receipt and generation, live context and active user. A new intent writes the tombstone and revokes matching rows, including rotated descendants. Cleanup retains referenced receipts and removes eligible expired metadata in bounded batches.

## H. Password, phone and logout compatibility

Valid, bound password or OTP verification advances before credential verification. OTP requests and resends preserve the challenge contract. Unbound clients retain the existing credential and bearer contract. Bound current logout can fence its own Google family without a bearer. Account-wide logout still requires a valid bearer for account-wide scope. The client preserves an unrelated refresh cookie and retains a logout action ID across an ambiguous network response. After a definitive denial, a same-account bearer recovery submits a fresh action.

## I. Backend API contract changes

| Endpoint | R1 behavior |
| --- | --- |
| `POST /api/v1/auth/browser-context` | Exact Origin, marker and JSON shape. Bootstrap 200 or explicit reset 204. |
| `POST /api/v1/auth/google/intent` | Accepts a live context proof, matching public context ID and action selector. |
| `GET /api/v1/auth/google/availability` | Same-origin Fetch Metadata and healthy enabled dependencies produce 204. |
| Existing authorize and callback | First-party authorize enforces same-origin Fetch Metadata. Callback retains M01A proof and fixed 303 results. |
| Guarded and ordinary refresh | Guarded POST activates a current intent once. A valid existing session conflict preserves the grant. Ordinary refresh checks the original binding and receipt for fenced families. |
| Existing login and logout | `X-Acadboost-Auth-Intent` identifies guarded actions. `X-Acadboost-Keep-Refresh-Cookie: 1` suppresses the cookie clear for an authorized logout without changing its revocation scope. |

## J. React integration

The UI combines the build flag, browser capabilities and backend availability before showing Google as available. The shared client bootstraps and registers a Google intent inside its existing Web Lock, keeps the public selector in existing browser storage, activates once and resolves `/me`. It suppresses blind restore after an uncertain activation. A stale cookie can require deliberate sign-in again.

## K. Acceptance cases

PASS applies to the checks stated in the evidence column. A partially exercised required scenario is BLOCKED until its remaining variants are demonstrated.

| Case | Status | Observations |
| --- | --- | --- |
| I01 | PASS | Newer bound logout 204. Older pending Google activation 401. No session row. |
| I02 | PASS | Failed password 401. Exact receipt superseded, original bearer and refresh 401. |
| I03 | PASS | A real transaction held the context lock and advanced intent while activation entered its transaction. Activation returned 401 and issued no session. Activation-first ordering was observed in HTTPS B27/B28 and I02. |
| I04 | PASS | Bound password login 200 and correct `/me`. Older Google family revoked. |
| I05 | PASS | Incorrect OTP 401 and successful OTP 200. Each fences the older Google family. Invalid challenge counter persisted. |
| I06 | PASS | OTP request 202 without generation movement. React remount and activation deduplication checks passed in focused tests. |
| I07 | PASS | Browser logout before callback and during activation 204. No usable Google family. HTTP tests preserve an unrelated cookie. |
| I08 | PASS | Bound bearer logout-all revokes its own account scope. Missing bearer returns 401 after context fencing only. |
| I09 | PASS | Newest attempt wins, stale callback preserves newer proof, callback/activation concurrency gives one issue. |
| I10 | PASS | Wrong selector 401. Valid session conflict 409, no cookie replacement, active family and grant preserved. |
| I11 | PASS | Repeated or differently typed accepted action 409, generation advanced once. |
| S01 | PASS | PostgreSQL observed fence waiting for refresh user lock. Both predecessor and successor revoked after release. |
| S02 | PASS | Committed fence followed by refresh 401, no successor. |
| S03 | PASS | Concurrent refresh 200/401 and replay revokes the linked family. |
| S04 | PASS | Suspension before waiting rotation and activation returned 401 with no successor or new family. Deletion cascaded linked sessions. Password reset and rotation were forced into both orders, with all in-scope rows revoked and an unrelated control bearer still valid. |
| S05 | PASS | Unrelated same-user and cross-account control sessions remain usable in intent and logout tests. Existing tenant authorization ran in the full backend suite. |
| S06 | PASS | Composite ownership rejects mismatch, historical NULL rows survive and user deletion preserves receipt history. |
| S07 | PASS | Owned Express processes were killed after activation and after the newer intent committed. A replacement process using an empty Valkey namespace denied stale bearer and refresh with zero eligible rows. A separate pending handoff was denied after cache-state loss. |
| S08 | PASS | Expired proof returned 401 and reset 204. Replacement could not adopt the old family. Cleanup erased its digest but retained the referenced receipt. Maximum generation returned 409 without wrap or intent creation. |
| B27 | PASS | Browser accepted active cookie then lost the body. Newer password 401, stale refresh 401 and bearer 401. Superseded receipt, zero usable family rows and unrelated family usable. |
| B28 | PASS | Browser accepted cookie then closed initiating tab. Same HTTP and PostgreSQL result as B27. |
| B29-R1 | PASS | Edge process was forcibly terminated while the activation body was held. The persistent profile retained the cookie. Newer password 401, stale refresh and bearer 401, zero active Google sessions. |
| B30-R1 | PASS | Reload then newer failed password returned refresh 401 without replay. Aborted document then current-context logout returned 204 and stale refresh 401. Interrupted activation followed by rejected phone verification returned 401 for both stale credentials, with no replay or live family. |
| B31-R1 | PASS | Password and phone switches returned 200. Later Google headers left stale bearer and refresh at 401, newer server session usable in a separate probe and reauthentication link visible. |
| B32-R1 | PASS | After a failed newer password intent or completed bound logout, late old headers yielded refresh and bearer 401 and zero live Google sessions. |
| B33-R1 | PASS | Reversed bootstrap headers accepted one matching selector and denied the other. An intent accepted before the delayed header could not authorize after it, returned 401 and remained unclaimed. Foreign host/port Origins returned 403 even with an expected forwarded host. |
| X01 | PASS | Sibling, null and missing Origin rejected. Spoofed forwarding host could not substitute for Origin. Form submission failed validation. No generation movement. |
| X02 | PASS | Copied callback denied before exchange. Duplicate or missing proof denied. |
| X03 | PASS | Real Valkey malformed, expired and replayed grant/state checks and HTTP malformed JSON denial. No unintended generation movement. |
| X04 | PASS | Backend flag-off denies Google availability while the bound password intent still fences. Synthetic Valkey/PostgreSQL dependency failures return safe 503 without a cookie. Frontend availability and unsupported-capability checks passed. |
| X05 | PASS | Same peer's eleventh bootstrap and context's thirty-first intent return 429 without a new cookie or generation. Captured fixture logs passed synthetic secret checks. Production ingress configuration and logging remain deployment gates. |

Evidence commands were the full backend Vitest run against isolated, migrated databases with `M01B_R1_DATABASE_URL`, `M01B_R1_VALKEY_URL` and `M01A_TEST_VALKEY_PORT` set, the targeted database reruns below, and `npm run test:e2e:google` with the fixture endpoints and browser path. No test exercised live Google.

## L. B27 and B28 before and after

| Observation | Earlier M01B | R1 HTTPS |
| --- | --- | --- |
| Newer syntactically valid password submission | 401 | 401 |
| Ordinary refresh with accepted Google cookie | 200 | 401 |
| Protected access | `/me` 200 for restored Google account | Original activation bearer `/me` 401 |
| Google family in PostgreSQL | One active row after rotation | Exact receipt superseded. One family row revoked, zero usable rows |
| Unrelated control family | Outside earlier probe | Bearer and refresh remained usable |

## M. Backend test results

The first full integrated backend run had 285 passed and 6 failed, with zero skipped. The historical API fixture used an older schema when invoking the current generated Prisma client. It now applies the additive auth migration after its historical snapshot and asserts preservation before continuing. Three roadmap publication/approval requests failed on the existing `ck_review_metadata` check when the PostgreSQL clock moved backward between submission and review. Two other review tests hit the 5-second test timeout. The affected product modules and historical migrations are outside this patch.

The next full run had 300 passed, 2 failed, 0 skipped. One failure was the existing roadmap snapshot's 5-second timeout. The other was the newly added retained-predecessor replay case, which ran before its service correction. The corrected focused run covering Google, HTTP fencing and the PostgreSQL lock contract passed 53. A later focused real PostgreSQL and Valkey run passed 23, including the added I03, S07 and S08 probes. Both exited 0. Focused counts overlap the full suite.

The isolated full reruns with `--maxWorkers=1 --testTimeout=20000 --no-cache` passed 303 and then 309 tests across 37 files, each with zero failures, zero skips and exit 0. They used a separate disposable database for R1 and enabled the original real-Valkey M01A tests and environment-gated backend tests. The additional S07 process-termination test passed in the focused real-database run. Backend syntax and Git whitespace checks passed.

The final full rerun included the S07 process-termination test and passed **310 tests across 37 files**, with zero failures, zero skips and exit 0.

## N. Frontend test results

An isolated full frontend run reported 294 passed, 0 failed, 0 skipped across 22 files, exit 0. The initial concurrent run had a Vitest worker startup timeout and included the deliberately red logout retry regression. A subsequent attempt without test-file isolation encountered cross-file mock interference. Frontend lint and the default-disabled production build passed. Vite emitted its bundle-size warning.

## O. HTTPS browser testing

The fixture runs real React and Express over the same HTTPS origin, PostgreSQL 17, disposable Valkey, Edge Chromium, a simulated provider on a separate HTTPS site, independent cookie jars and multiple tabs. Its proxy independently gates response headers and bodies. B27, B28 and the password late-header case inspected browser cookies, HTTP status and authoritative PostgreSQL rows. The existing simulated Google happy path, cancellation and wrong-browser denial were also exercised.

The final integrated HTTPS run exited 0 and captured 16 scenarios, including B29 with both cookies retained after termination and reversed bootstrap around an accepted intent. Cookie persistence was inconclusive in earlier runs. The final run's synthetic-secret checks passed.

Run from `frontend` with `npm run test:e2e:google` and explicit disposable service URLs. The [fixture instructions](../../frontend/tests/e2e/README.md) describe its environment.

## P. Migration rehearsal and historical preservation

**MIGRATION REHEARSED — DEVELOPMENT DEPLOYMENT PENDING AUTHORIZATION**

PostgreSQL 17.11 was confirmed. The protected custom source backup contained 291,919 bytes, passed archive-list validation and had SHA-256 `1b4399dfef9ed53b5644c16a9c76cc04acf0df54feeef9aedeb1429c30fc76a7`. A historical clone was restored and rehearsed from seven to eight migrations. The database investigator compared 28 original tables with the added nullable session column normalized. All matched and all 560 historical session links remained NULL at rehearsal. The fresh disposable migration chain reached eight migrations independently. Prisma validation and migration status passed on the historical clone. The development database was checked read-only and still had seven finished migrations and no fencing table.

## Q. Independent security review

The independent source review found no path that authenticates a Google family after the newer bound intent commits. It examined Origin, proof and fixation boundaries, exact family ownership, locks, replay, expiry, logging, legacy behavior and rollout. Follow-up changes addressed logout scope, retry after definitive denial, credential deadlines after blocking locks, and replay of an expired retained predecessor. The browser-context reset API exists. The UI does not expose a dedicated reset action for a stale binding while Google is disabled.

## R. Remaining risks

A delayed header can replace the newer browser refresh cookie. The old Google credentials remain unusable. A user may need to sign in again while the newer server session remains valid. Scope validation depends on canonical HTTPS ingress and primary PostgreSQL reads. Ingress logs must omit auth query, cookie and Authorization values. Mixed deployment with an old binary could bypass fenced authorization.

Bootstrap currently meters the directly observed socket peer. Before enablement behind shared ingress, provide per-verified-client-address throttling at the ingress or approve a restricted proxy trust configuration. The fixture validates the peer limit and leaves forwarding headers untrusted.

## S. Deployment and rollback requirements

Development migration needs separate authorization for the identified database, an approved backup and a migration-preservation runbook. A rollout must apply the additive schema before the new binaries serve fenced sessions. Keep Google flags off pending deterministic and real-provider acceptance. Roll back with fence-aware binaries or first retire all affected families and pending grants. Preserve the receipt link and additive schema for retained history.

M01B.6 needs a separately approved canonical HTTPS origin, a Google Web OAuth client with the exact `/api/v1/auth/google/callback` URI registered on that origin, approved test users and consent policy, protected provider credentials, server signing key, reachable Valkey and approved ingress. Test real-provider acceptance before any public enablement.

## T. Changed files

- Backend setup and entry points. `backend-js/.env.example`, `backend-js/src/app.js`, `backend-js/src/core/config.js`, `backend-js/src/core/valkey.js`.
- Schema. `backend-js/prisma/schema.prisma`, `backend-js/prisma/migrations/20261113_m01b_r1_browser_auth_intents/migration.sql`.
- Authentication. `backend-js/src/modules/auth/browserIntents.js`, `google.js`, `googleHandoff.js`, `phone.js`, `routes.js`, `service.js` in that directory.
- Backend tests. `backend-js/tests/auth-fencing.test.js`, `google.test.js`, `google-handoff-config.test.js`, `db/auth-fencing-http.test.js`, `db/browser-auth-intent.test.js`, `db/roadmap-review-historical-api.test.js`, `helpers/auth-fencing-process.mjs` under the same test directory.
- Frontend setup and routing. `frontend/.env.example`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/app/App.jsx`.
- Frontend authentication. `frontend/src/features/auth/AuthMethodNav.jsx`, `GoogleLoginPage.jsx`, `GoogleCompletionPage.jsx`, `GoogleHandoff.test.jsx`, `authApi.js` in that directory. Shared files are `frontend/src/shared/api/client.js` and `frontend/src/shared/api/googleSession.test.js`.
- Browser verification. `frontend/tests/e2e/README.md`, `frontend/tests/e2e/google-r1.mjs`, `frontend/tests/e2e/google-r1-restart-child.mjs`.
- Documentation. `docs/architecture/M01B-google-react-handoff-specification.md`, `docs/architecture/M01B-R1-server-session-fencing-specification.md`, `docs/verification/M01B-google-react-handoff.md`, `docs/verification/M01B-R1-server-session-fencing.md`.

## U. Final verdict

**M01B-R1 IMPLEMENTATION VERIFIED — DEV MIGRATION AND REAL PROVIDER PENDING**

B27 and B28 passed, including exact-family database and unrelated-session checks. The full regression, HTTPS browser and disposable migration gates passed. Development migration and real-provider acceptance require separate authorization.
