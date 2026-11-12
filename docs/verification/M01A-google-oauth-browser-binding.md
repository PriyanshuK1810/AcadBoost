# M01A Google OAuth initiating-browser binding

## A. Executive summary

A copied Google callback now fails before provider exchange or account/session writes unless the callback browser presents the initiating attempt's correlation cookie. Wrong, missing and malformed proofs leave the legitimate state usable. Actual Valkey and a two-context HTTPS Chromium fixture verified single-use consumption and browser isolation.

## B. Original security issue

The authorize route generated OAuth state, nonce and a PKCE verifier. The callback consumed the Valkey record with `GETDEL` using only the query state. The pre-fix regression started authorization in one cookie jar and used a valid mock-provider callback in a different jar. The second jar received HTTP 200 instead of 401.

## C. Implementation

- Authorize generates an independent 32-byte cryptographic secret. It stores a SHA-256 digest beside the nonce and PKCE verifier in the existing state key with `NX` and a 600-second TTL. The raw proof is carried only in a Secure, HttpOnly, SameSite=Lax, host-only `__Secure-outpost_google_correlation` cookie at `/api/v1/auth/google/callback`.
- Callback requires a well-formed state and proof. The Valkey operation returns only the nonce and verifier if proof matches. An unrelated, replayed or expired callback leaves any current correlation cookie alone. A matched callback clears the correlation cookie using the same attributes, including on subsequent provider or account validation failure.
- The callback is no-store and retains the existing bearer JSON, refresh cookie and authentication event behavior. Discovery, PKCE, issuer, nonce, audience, authorized party, signature, expiry, verified email, subject lookup and identity collision behavior stay on their existing paths.

## D. Atomic Valkey design

One `EVAL` reads the exact state key, safely decodes the record, checks the cookie digest and validates the stored nonce and verifier before deleting the key and returning those fields. The read, compare and delete are indivisible. Wrong proof never reaches the delete and leaves TTL unchanged. Missing, expired, malformed and already consumed records return a denial. Transport failure produces the existing safe 503. On disposable Valkey 9.1.2, six requests using the same valid proof produced one 200 and five 401s, one token exchange, one identity, one session and one auth event. Expiry and three malformed record representations were tested. [Valkey scripting semantics](https://valkey.io/topics/eval-intro/)

## E. Test results

Commands ran from `backend-js` with the installed Node and Vitest dependencies. The disposable Valkey suite was opted in through `M01A_TEST_VALKEY_PORT` on loopback port 63093.

| Check | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|
| Baseline `node node_modules/vitest/vitest.mjs run tests/google.test.js --maxWorkers=1 --no-cache` | 10 | 0 | 0 | 0 |
| Pre-fix targeted run with `-t 'copied to a different browser'` | 0 | 1 | 10 | 1 |
| First green Google suite without disposable Valkey | 17 | 0 | 6 | 0 |
| First focused run with disposable Valkey | 57 | 1 | 0 | 1 |
| Corrected focused OAuth, session, core, logging, routes and authorization run | 58 | 0 | 0 | 0 |
| First full backend run with disposable resources | 259 | 1 | 0 | 1 |
| Corrected full backend run with disposable resources | 260 | 0 | 0 | 0 |
| HTTPS Edge fixture with real Valkey, mocked OIDC and in-memory account/session fixture | 1 | 0 | 0 | 0 |
| Password/refresh/logout probe with disposable PostgreSQL | 1 | 0 | 0 | 0 |

The first Valkey integration run and first full run failed because the fixture used the same property name for a browser factory and its initiating browser. The corrected fixture passed with the production Lua unchanged. The first HTTPS fixture timed out while intercepting a redirected mock-provider page. The corrected fixture intercepted the authorize redirect and then navigated to the mocked provider origin, with the real application's Set-Cookie header processed by Chromium. Both initial issues were in test fixtures.

The focused command used `node node_modules/vitest/vitest.mjs run tests/google.test.js tests/auth-flow.test.js tests/recovery.test.js tests/phone.test.js tests/tokens.test.js tests/core.test.js tests/request-errors.test.js tests/route-parity.test.js tests/learning/routes.test.js --maxWorkers=1 --no-cache`. The full runner applied migrations only to disposable PostgreSQL, used a dedicated MinIO bucket and ran `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-cache --reporter=default --reporter=json --outputFile.json=<temporary path>`. The independent session probe also applied the existing migrations only to a new disposable database. Syntax checks for both JavaScript files and `git diff --check` passed. Prisma configuration and schema were outside the patch.

## F. Security matrix

| ID | Scenario | Result and evidence |
|---|---|---|
| G01 | Initiating browser succeeds | PASS. HTTP 200 in HTTPS browser and signed-token route tests. |
| G02 | Copied callback in different browser | PASS. HTTP 401 with two isolated cookie contexts. |
| G03 | Wrong browser attempts first | PASS. Original state and both jars' valid attempts survived the denial, then original succeeded. |
| G04 | Missing cookie | PASS. HTTP 401, state retained and no side effects. |
| G05 | Incorrect cookie | PASS. HTTP 401 and real Valkey record and TTL preserved. |
| G06 | Expired state | PASS. Shortened fixture TTL, waited for actual Valkey expiration and observed HTTP 401. |
| G07 | Replay | PASS. Repeated state with original proof returned 401 after consumption. |
| G08 | Concurrent valid callbacks | PASS. Six parallel requests produced one success, one session and one exchange. |
| G09 | Wrong callback issuer | PASS. HTTP 401 before provider fetch, matched correlation cookie cleared. |
| G10 | Wrong nonce | PASS. Signed wrong nonce denied and correlation cookie cleared. |
| G11 | Wrong audience | PASS. Signed wrong audience denied and correlation cookie cleared. |
| G12 | Invalid Google token | PASS. Invalid token denied. Expired, unverified email and wrong authorized party cases also denied. |
| G13 | Valkey unavailable | PASS. Interrupted loopback transport returned safe 503 with no auth side effects. |
| G14 | Missing provider configuration | PASS. Authorize and callback returned controlled 503. |
| G15 | Existing Google subject | PASS. Repeat sign-in reused the same linked identity. |
| G16 | Email collision | PASS. The password account stayed separate under the existing resolver. |
| G17 | Suspended account | PASS. Denied after verification, cleared correlation and created no session. |
| G18 | Latest attempt in shared jar | PASS. After a new authorize response replaced the cookie, the older callback was denied and did not clear the newer proof. The latest callback succeeded. |
| G19 | Cookie attributes | PASS. Header contract, Secure/HttpOnly/Lax, host-only and callback path checked by HTTPS Chromium. |
| G20 | OAuth secrets in logs | PASS. Captured actual app stdout/stderr. No fixture code, state, nonce, verifier, proof, digest, access token or client secret appeared. |
| G21 | Password login | PASS. Isolated PostgreSQL accepted login and emitted the existing refresh cookie. |
| G22 | Refresh/logout | PASS. Isolated PostgreSQL rotated refresh, then logout revoked access and refresh. |
| G23 | No account/session mutation on invalid proof | PASS. No user, identity, session or auth event was created during wrong/missing/expired proof checks. |
| G24 | No provider request on invalid proof | PASS. Provider call counter stayed zero before the matched callback. |

## G. Session compatibility

The successful Google callback still emits the existing `access_token`, `token_type` and `expires_in` fields. It writes the same Secure HttpOnly Strict `outpost_refresh` cookie at `/api/v1/auth`. Tests exercised existing subject reuse and email collision behavior. A real disposable PostgreSQL probe returned 201 for registration, 200 for password login and rotation, 204 for logout, and 401 for both access and refresh after logout.

## H. Browser and cookie verification

Edge Chromium used two separate HTTPS contexts at `https://localhost:50183` with an ephemeral self-signed fixture certificate. The mocked provider was a top-level navigation at `https://accounts.google.com`, intercepted by Playwright. Its top-level callback navigation returned 401 in the wrong context and 200 in the initiating context. The HTTPS alternative host `https://127.0.0.1:50183` returned 401 with the same state. Chromium sent the cookie on the callback path and omitted it on the authorize path and alternate hostname. The callback cleared it after success while preserving the separate refresh cookie.

## I. Changed files

- `backend-js/src/modules/auth/google.js` adds correlation cookies and proof-bound state consumption.
- `backend-js/tests/google.test.js` starts full OAuth attempts from independent simulated jars, preserves identity tests and adds opt-in integration checks using the production Valkey client.
- `docs/verification/M01A-google-oauth-browser-binding.md` records verification and remaining enablement requirements.

Independent review confirmed the atomic compare-before-delete boundary and flagged host/TLS setup and in-flight response ordering. The HTTPS fixture resolved the browser verification gap. The disposable Valkey container, PostgreSQL databases and MinIO buckets were cleaned up. The HTTPS server and browser contexts closed, and the generated TLS files were removed. The working tree began clean on `main` at `828eef4e5e772836aafe5091e11e56a05e44be23`.

## J. Remaining limitations and M01B dependencies

The current local runtime has no configured Google client or callback origin. The example points at `http://127.0.0.1:8000/api/v1/auth/google/callback`. M01B needs an approved same-host HTTPS authorize/callback deployment, a registered Google redirect URI, a fixed first-party handoff, account-policy approval and actual Google provider acceptance before exposing the UI. Host-only cookies cannot span `localhost` and `127.0.0.1`. Loopback Secure-cookie exceptions vary and were outside the verified HTTPS contract.

The shared-cookie policy applies when a browser has accepted the replacement cookie. Two simultaneously in-flight authorize responses can arrive out of request-start order, and a callback already carrying an old valid proof can finish later. One callback-scoped cookie cannot enforce browser-wide request-start ordering or make an earlier cleanup response conditional on the browser's newer cookie. M01B should account for these availability races before enabling the UI. The proof comparison and single-use authorization still apply to each received callback.

## K. Final verdict

**M01A VERIFIED.**
