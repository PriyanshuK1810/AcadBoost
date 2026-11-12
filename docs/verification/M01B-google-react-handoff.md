# M01B Google OAuth React handoff verification

## A. Executive summary

The simulated-provider flow reached the React dashboard through the guarded activation endpoint. Two HTTPS browser tests reproduced a release blocker. When Chromium accepted the Google refresh cookie and then lost the response body or closed the initiating tab, a later password sign-in attempt did not make that cookie unusable. Ordinary refresh restored the older Google account in both cases.

Implementation stopped at the release gate. The partial patch and its tests are available in the working tree for review.

## B. Verified source revision

The checkout started and ended at `2f7df3efce4c46217d155657b3bf7dc0fe0c6ff9` on `main`. The results below cover the uncommitted M01B changes on that revision. The pre-existing untracked architecture specification was preserved. The Git index was empty.

The browser and full backend fixtures used new disposable databases restored from a schema-only dump. The full backend runner also used a dedicated MinIO bucket. Existing migration regression tests ran their SQL against disposable fixtures. The project migration runner was never invoked and the development database was read only for the schema dump.

## C. Implemented backend contract

- Google authorization at `GET /api/v1/auth/google/authorize?attempt=<uuid>` uses the M01A correlation proof and an S256 PKCE challenge.
- A verified callback returns a fixed 303 to `/auth/google/complete` and prepares the short-lived handoff. The permitted failure redirects use `result=cancelled`, `result=invalid`, or `result=unavailable`. Session creation and the standard refresh cookie occur only during activation.
- `POST /api/v1/auth/refresh` selects handoff mode by `X-Acadboost-Google-Attempt`. It checks the configured exact Origin, UUID, pending cookie and empty body. The code checks for an existing usable refresh cookie without rotating it and returns 409 `session_conflict`. The ordinary refresh branch remains available for requests without the header.
- Session issuance reuses ADR-003 and its existing bearer response and refresh-cookie helper. The linked-account status check takes the user row lock through session creation. The real PostgreSQL test exposed a generated Prisma delegate naming mismatch, corrected to `oAuthIdentity`. Returning-user, email collision and concurrent suspension cases still need corrected integration tests.

## D. Implemented frontend contract

The Google start and completion routes use the existing shared session client. Initiation stores a non-credential attempt UUID in shared and tab-local storage under the existing Web Lock, then navigates to the same-origin authorize route. Completion checks the tab attempt and the shared intent, activates once, loads `/api/v1/me`, and replace-navigates by account type. The completion route offers accessible error feedback and explicit recovery choices.

Newer login and logout actions invalidate the earlier Google attempt. A visible stale activation response can be compensated using its exact bearer while omitting cookies from the revocation request. An uncertain activation leaves a local marker that blocks automatic restoration and repeat activation through the shared client. B27 and B28 bypassed this UI safeguard using the browser's own cookie jar and the ordinary refresh API.

The start button currently depends on the frontend flag and browser capabilities. With mismatched flags it can appear while the backend rejects authorization. Backend availability gating remains incomplete.

## E. OAuth and handoff security

An independent browser that opened the copied callback got the fixed invalid 303 before a provider exchange. The initiating browser then completed exactly one provider exchange. The callback never sent the active refresh cookie in the observed browser run. The separate pending cookie is `__Secure-outpost_google_handoff`, Secure, HttpOnly, SameSite=Strict and host-only, scoped to `/api/v1/auth/refresh`, with a 120-second lifetime. The active cookie retains its existing Secure, HttpOnly and Strict attributes and `/api/v1/auth` path.

The callback uses fixed relative locations and no-store/no-referrer headers. The browser fixture checked captured application logs for synthetic provider secrets, state, nonce, code, verifier, ID token and observed cookie values. It inspected callback locations for fixed paths. Production ingress and real-provider logs remain outside this check.

## F. Valkey and session atomicity

M01A state remains bound to the digest of the initiating browser proof. The new handoff stores the verified identity projection and selector under a digest of a separate random proof. Valkey TTL bounds the grant to 120 seconds. The approved contract also specifies an expiry in the handoff record, which the stopped patch has yet to add. One Lua operation compares the selector, validates the record and deletes it before issuing a session. PostgreSQL resolves the identity and creates the ADR-003 session in a transaction. The Valkey consume and PostgreSQL transaction are separate operations, so a failed PostgreSQL write after consumption requires a fresh sign-in attempt.

The pending grant bounds redemption. An active refresh cookie issued during redemption follows ADR-003 and is independent of the browser's local attempt marker. That gap produced B27 and B28.

## G. Browser and cookie verification

Edge Chromium ran against Vite and Express at `https://localhost:56854`, with a simulated provider at `https://127.0.0.1:56853`, real disposable PostgreSQL and real disposable Valkey. The disposable browser context accepted the fixture certificate. The HTTPS proxy intercepted the provider redirect for simulation and forwarded application cookies. For race tests it flushed activation response headers to Chromium, observed the active cookie in the context, and controlled when the body was delivered. The provider exchanged synthetic tokens only.

The happy path reached the student dashboard. After reload, ordinary refresh succeeded and `/api/v1/me` returned the user matched to the Google subject in PostgreSQL. A separate context was denied the copied callback and the initiating browser retained its opportunity to complete. Cancellation returned the fixed cancelled route and left zero active Google sessions. Sanitized observations are in the local test artifact `browser-evidence.json`.

## H. Race-condition verification

An active session below is an unrevoked, unreplaced PostgreSQL session row for the synthetic Google subject, checked after the newer action or ordinary refresh. Each case used a fresh browser context and a separate synthetic subject.

| Case | HTTP and browser behavior | PostgreSQL result |
| --- | --- | --- |
| B24 · Logout before callback | Password sign-in 200, logout 204, then late callback 303. React made zero activation requests. | Zero active Google sessions. |
| B25 · Logout during activation | Activation 200 with delayed body. Once released, exact-family compensation returned logout 204. The companion tab's logout recovery refresh then got 401 and surfaced a failed sign-out state. | Zero active Google sessions. The security property held in this ordering. The logout confirmation UX remains unresolved. |
| B26 · Successful account switch during activation | Activation 200 with delayed body. After release, exact-family logout returned 204 and the newer password login returned 200. The shared client resolved the intended password user through `/me`. | Zero active Google sessions. The newer account remained current. |
| B27 · Lost activation response | Activation headers and active cookie reached Chromium. The proxy dropped the body after a newer password intent began. The newer password request returned 401. Ordinary refresh then returned 200 and `/me` returned 200 for the superseded Google user. | **One active Google session remained after rotation.** |
| B28 · Initiating tab closed | Activation headers and active cookie reached Chromium. The initiating tab closed before observing the body, after a newer password intent began. The newer password request returned 401. Ordinary refresh then returned 200 and `/me` returned 200 for the superseded Google user. | **One active Google session remained after rotation.** |

The newer password requests in B27 and B28 intentionally used invalid credentials so they would express an explicit account-switch intent without issuing a replacement cookie. A successful password switch is covered separately by B26. Tab close was tested in B28. A full browser process crash was outside that run.

## I. Automated tests

Rows are individual runs. Focused reruns overlap their corresponding full suites and should be read independently.

| Run | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: |
| Full backend on the initial partial patch, 34 files | 249 | 24 | 0 | 1 |
| Google and configuration on the stopped patch, two files | 14 | 22 | 0 | 1 |
| Initial full frontend | 288 | 1 | 0 | 1 |
| Focused rerun of the roadmap picker focus test | 1 | 0 | 80 | 0 |
| Full frontend rerun with `--pool=forks`, 22 files | 289 | 0 | 0 | 0 |
| Google UI component checks | 18 | 0 | 0 | 0 |
| Shared session/client checks, including four Google checks | 21 | 0 | 0 | 0 |
| Frontend auth journey rerun | 6 | 0 | 0 | 0 |
| Frontend lint and default-disabled build | — | — | — | 0 each |
| Backend syntax checks, eight changed JavaScript files | 8 | 0 | 0 | 0 |
| Git whitespace check | — | — | — | 0 |

The initial backend run failed in the Google suite while callback expectations and the attempt fixture were being updated. In the stopped-patch rerun, 12 configuration tests and two Google contract tests passed. All 22 Google failures compared the fixed 303 callback response to the old 200, 401 or 503 contract. Later assertions in those tests did not execute. The new handoff path was exercised by the passing contract test and the browser run. The initial full frontend run failed in roadmap version picker focus. Both the focused rerun and the full rerun passed. The auth journey focused run also had an initial OTP focus failure before its six-test rerun passed. The final build emitted a bundle-size warning.

The first HTTPS attempt exited 1 at the invalid Prisma delegate. The corrected probe exited 0 and recorded the two security failures as observations. The browser process exit confirms the fixture ran to completion. The release verdict follows the application results above.

### Required security matrix

| ID | Status | Evidence |
| --- | --- | --- |
| B01 | Pass | Real browser authorization 302 and passing authorize contract. |
| B02 | Partial | Default-off configuration passed. The combined outage assertion still expected the old callback status. |
| B03 | Pass | Browser-bound callback produced the fixed successful 303. |
| B04 | Pass | Separate browser got fixed invalid 303 and made no exchange. |
| B05 | Partial | The old Google replay test stops on the changed callback contract. |
| B06 | Pass | Fixed callback locations and no bearer or provider code on the callback response in the passing contract test. |
| B07 | Pass | Pending cookie attributes, 120-second age and digest-keyed record checked. |
| B08 | Unverified | Pending handoff wall-clock expiry was outside the completed tests. |
| B09 | Unverified | Missing proof has a rejection path. Dedicated HTTP check pending. |
| B10 | Incomplete | Selector comparison precedes deletion in Lua. With a usable standard cookie, the current branch can return 409 before verifying the selector. Wrong selector and grant preservation need a Valkey assertion. |
| B11 | Unverified | Exact Origin is checked in code. Wrong-origin HTTP test pending. |
| B12 | Unverified | Atomic deletion is in place. Dedicated handoff replay test pending. |
| B13 | Unverified | Dedicated concurrent activation test and PostgreSQL family count pending. |
| B14 | Partial | React handles conflict and explicit recovery. Backend conflict and grant preservation test pending. The 409 check precedes validation of a well-formed grant. |
| B15 | Pass | Ordinary refresh on reload passed. Existing session tests passed in the full backend run. |
| B16 | Unverified | Returning-subject test stops on the changed callback contract. |
| B17 | Unverified | Collision test stops on the changed callback contract. |
| B18 | Unverified | Status check and row lock are present. Suspended-account test stops on the changed callback contract. |
| B19 | Pass | Browser reached student dashboard and `/me` matched the Google-linked user. |
| B20 | Pass | Browser reload restored the same user by ordinary refresh and `/me`. |
| B21 | Pass | Cancellation gave the fixed 303 and no active session. |
| B22 | Partial | React renders fixed invalid results. Backend provider error and expiry tests stop on the changed callback contract. |
| B23 | Partial | Duplicate click, StrictMode and shared-client suppression passed. Multi-tab concurrent redemption test pending. |
| B24 | Pass | Zero activation requests and zero active Google sessions after late callback. |
| B25 | Partial | Zero active Google sessions after exact compensation. Companion logout reported failed confirmation. |
| B26 | Pass | Password account remained current and the older Google family was revoked. |
| B27 | Fail | Lost response left a usable Google refresh cookie after a newer intent. |
| B28 | Fail | Tab closure left a usable Google refresh cookie after a newer intent. |
| B29 | Partial | Safe unavailable paths exist. Legacy outage assertions and explicit activation outage test still need coverage. |
| B30 | Pass in fixture | Fixed callback locations and checked synthetic secret values absent from captured application logs. |
| B31 | Pass | Password regression suite passed and password registration and login worked in Chromium. |
| B32 | Pass | Phone backend regression and frontend auth journey passed. |
| B33 | Pass in regressions | Existing revocation tests passed and B25/B26 compensation revoked the intended family. B27/B28 remain failures. |
| B34 | Pass in regressions | Existing tenant authorization and workspace regression checks passed in the backend run. Google membership isolation still needs its identity-specific coverage. |
| B35 | Partial | Wrong-browser rejection and initiator recovery passed in Chromium. The full M01A regression suite is pending migration to the approved 303 contract. |

## J. Security review results

- Login CSRF and wrong-browser handling retained the M01A state proof. Browser evidence showed the wrong context never reached the provider exchange.
- Fixed first-party callback locations and frontend route validation constrained redirects. The callback did not issue the active session, and the activation branch reused normal refresh-cookie attributes.
- Independent review found an unexpected callback exception could return JSON 500 and that linked-user status was read without a lock. The stopped patch redirects unexpected callback failures to the fixed unavailable result and locks the linked user through issuance. Dedicated exception and concurrent suspension coverage remains due.
- The Valkey consume prevents a single grant from issuing twice by design. The concurrent redemption and malformed-state acceptance checks need a complete corrected rerun.
- The read-only session conflict check and client Web Lock have no server-side record of newer browser intent. With a lost response or closed tab, no exact bearer is available for compensation. The stale family remains eligible for ordinary refresh and bearer authentication.

## K. Existing authentication compatibility

The full backend run's password, phone, session rotation and revocation, request logging and validation, and organization authorization tests passed. The Google failures were isolated to its suite. The full frontend run and targeted auth/session tests are reported above. Browser verification covered password login, ordinary rotation, Google family revocation after a visible response, and role navigation. The Google identity-specific tenant isolation and full M01A regression remain open.

## L. Changed files

| Area | Paths |
| --- | --- |
| Backend | `backend-js/src/app.js`, `backend-js/src/core/config.js`, `backend-js/src/modules/auth/google.js`, `backend-js/src/modules/auth/googleHandoff.js`, `backend-js/src/modules/auth/routes.js`, `backend-js/src/modules/auth/service.js` |
| Backend tests | `backend-js/tests/google.test.js`, `backend-js/tests/google-handoff-config.test.js` |
| React | `frontend/src/app/App.jsx`, `frontend/src/features/auth/AuthMethodNav.jsx`, `frontend/src/features/auth/GoogleLoginPage.jsx`, `frontend/src/features/auth/GoogleCompletionPage.jsx`, `frontend/src/features/auth/authApi.js` |
| Session client and frontend tests | `frontend/src/shared/api/client.js`, `frontend/src/shared/api/googleSession.test.js`, `frontend/src/features/auth/GoogleHandoff.test.jsx` |
| Configuration and verification | `backend-js/.env.example`, `frontend/.env.example`, `docs/verification/M01B-google-react-handoff.md` |

## M. Deployment and provider requirements

`OUTPOST_GOOGLE_HANDOFF_ENABLED` and `VITE_GOOGLE_SIGN_IN_ENABLED` default to false. An enabled backend requires a canonical `OUTPOST_PUBLIC_APP_ORIGIN`, the exact corresponding `OUTPOST_GOOGLE_REDIRECT_URI`, a Google client ID and secret, a server auth signing key, and reachable Valkey. Deployment should verify that the frontend and backend flags match. A single HTTPS host must serve both React and `/api/v1`. The ingress must route API paths before SPA fallback, preserve Location and Set-Cookie, trust only the approved forwarding path, and omit sensitive query strings, cookies and authorization headers from logs.

## N. Remaining risks and server-side proposal

1. Establish a same-origin, server-issued browser binding before Google navigation. Use a high-entropy, host-only HttpOnly cookie and store its digest server-side. Carry a monotonic intent generation on each pending Google attempt. Keep the M01A proof and Valkey handoff independent of the browser binding.
2. At explicit password or phone sign-in, account switch, or logout, advance the browser generation at a first-party server boundary before credential validation or a cookie change. Require exact Origin and the browser binding so a cross-site request cannot supersede the intent. A rejected password or phone credential must still supersede an older Google attempt.
3. In one PostgreSQL transaction, lock the browser intent record, verify the activation's generation, create the existing ADR-003 family and record the exact family ID in an activation receipt. A newer intent must take the same lock, advance the generation and revoke the exact superseded family, including any rotated descendant. If the newer intent commits first, reject the older activation. If activation commits first, the newer intent must revoke that family without waiting for a response or client bearer. Review lock order against ordinary rotation and use an authoritative family revocation check if needed to prevent a concurrent rotate from leaving a usable descendant.
4. Test late headers after a successful password or phone switch separately from the lost-body cases. A stale header may overwrite a cookie even if its family is rejected. Validate that ordinary refresh cannot restore the older account and that the newer family remains valid. If the approved UX also requires recovery from cookie overwrite, review a separate, short-lived acknowledgement that keeps the first cookie provisional until the browser confirms the receipt and the server rechecks the generation.
5. Require evidence from both ordering directions, including a lost body, a closed tab, an aborted fetch, reload, rotation overlapping revocation, and a newer login that fails. Assert ordinary refresh, `/me`, exact family ownership, and persistence across server restart. Decide binding and receipt expiry and data retention before implementation.

The server binding, generation and receipt materially change the approved contract and require separate approval. This patch contains none of that design.

## O. M01B.6 acceptance dependencies

1. Obtain separate approval and pass the deterministic race tests after a server-side fix. Use a separately approved HTTPS test origin with DNS and TLS, with ingress for React and the same-origin API.
2. Register a Google OAuth **Web application** client and authorize exactly `<approved HTTPS origin>/api/v1/auth/google/callback`, including scheme, host, port where used, and path. Use `openid email profile` and configure the consent audience and authorized test users for the chosen test setup. [Google OAuth web server documentation](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
3. Inject `OUTPOST_GOOGLE_CLIENT_ID`, `OUTPOST_GOOGLE_CLIENT_SECRET` and `OUTPOST_AUTH_SIGNING_KEY` via approved server-side secret configuration. Supply healthy Valkey and the canonical origin and redirect settings. Limit any test enablement to the approved acceptance environment.
4. Run real-provider success, cancellation, invalid/expired flow, returning subject, reload and logout, and wrong-browser rejection. Include a new test user without memberships, a returning linked test user and a verified email collision with a separate first-party account. Verify tenant isolation and inspect sanitized application and ingress logs.
5. Enable for public users only after deterministic security acceptance, real-provider acceptance, and explicit rollout approval.

## P. Final verdict

**M01B BLOCKED — SECURITY OR ARCHITECTURE**

B27 and B28 restored a superseded Google account through ordinary refresh after a newer authentication intent. No completion commit was created.
