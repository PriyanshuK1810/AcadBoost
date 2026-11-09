# ADR-003: Outpost-owned authentication model

Status: Accepted (formalizes the authentication architecture approved in Layers 1–2).
Date: 2026-09-17.
Scope: Authentication identity, credential, linking, and session invariants; Phase 6 access enforcement clarification.

## Context

Outpost needs password, passwordless phone, and Google sign-in while preserving one canonical user identity. A person may add or remove authentication methods over time without duplicating their learning history or organization memberships. Authentication must remain separate from the organization-scoped authorization model defined by [ADR-002](ADR-002-organization-tenant-model.md).

This record follows the master build prompt and [ADR-001](ADR-001-modular-monolith-cloud-independence.md). It freezes the approved model before storage and endpoint implementation; it does not create authentication code, schema, provider adapters, or secrets.

## Decision

### Outpost owns the canonical account

Outpost owns authentication and maintains one canonical `users` record for each person. Authentication methods are linked identities or credentials that resolve to that user:

| Authentication method | Canonical storage identity | Primary proof |
| --- | --- | --- |
| Email or username plus password | `password_credentials.user_id` | Argon2id password verification |
| Passwordless phone OTP | `phone_identities.phone_e164` | Successful protected OTP challenge |
| Google OAuth 2.0 / OpenID Connect | `(oauth_identities.provider, provider_subject)` | Validated Google authorization response and stable subject |

Authentication answers who the user is. It grants no organization role by itself. Organization membership and tenant-aware authorization determine what the authenticated user may do.

`primary_email` and `username` are account attributes used by the password flow; neither is a universal identity-linking key. A Google email is provider metadata, not the provider identity key. Phone numbers use normalized E.164 form. Storage uniqueness and normalization rules must make each supported login identifier resolve deterministically.

### Password authentication

Registration accepts display name, username, email, and password. Validate and normalize identifiers, enforce uniqueness, hash the password with Argon2id, and create the user and password credential atomically. Passwords have a minimum length of 12 characters, allow long passphrases, enforce a reasonable maximum, use no arbitrary uppercase/symbol composition rules, and are never silently truncated.

Password login accepts email or username plus password. Normalize the identifier, resolve the account and credential, verify Argon2id, validate account state, and then create a session. Invalid identifiers and invalid passwords return the same generic credentials error. Never log or expose plaintext passwords or password hashes.

### Phone OTP authentication

Phone OTP is a passwordless authentication method, not a second factor for the initial product. Normalize the phone number to E.164 before rate limiting or identity lookup. Challenges use six digits, expire after five minutes, are single-use, allow at most five verification attempts, and enforce a 30–60 second resend cooldown plus appropriate rate limits.

Because a six-digit code has low entropy, protect stored challenges with a server-held HMAC or equivalent secret-backed construction rather than an ordinary unsalted hash. Generate codes with a cryptographically secure source. Production codes must never be logged; delivery occurs through the provider-neutral `SmsProvider` boundary from ADR-001.

Successful verification consumes the challenge, resolves or establishes the permitted phone identity path, validates account state, and creates a session. The detailed new-user and linking user experience will be implemented in the applicable phases without weakening the proof-of-control rules below.

### Google authentication

Use OAuth 2.0 / OpenID Connect authorization-code flow. Validate `state`, `nonce`, redirect URI, code exchange, and provider response. Resolve the identity by Google's stable subject identifier stored as `(provider, provider_subject)`, never by email alone.

Google email may populate or display provider metadata after validation, but matching email does not authorize merging two established accounts. Provider handling remains inside the OAuth integration boundary; canonical users, sessions, and authorization remain owned by Outpost.

### Explicit account linking and unlinking

An authenticated user may link phone, Google, or a password credential only after proving control of the new method. Account-linking operations are explicit and atomic. If the method is already attached to another established user, reject or route to explicit collision recovery; never silently merge accounts based on email, phone presentation, or provider metadata.

Unlinking requires a current authenticated session, applicable reauthentication or proof where required, and must never remove the user's final valid authentication method. Listing identities may expose safe method metadata but never credential hashes, raw tokens, OTP protections, or provider secrets.

### Sessions and browser credentials

Use a short-lived access credential plus a long-lived rotating refresh session. The initial access lifetime target is 10–15 minutes. In browsers, keep the access token in memory and the refresh token in a `Secure`, `HttpOnly` cookie with appropriate cookie scope and same-site/CSRF protections chosen during implementation.

Refresh tokens are cryptographically random. Store only their protected hashes server-side. Each refresh belongs to a token family and rotates on use. Reuse of an already-rotated token is replay: revoke the affected family, record a security event, and require reauthentication. Sessions are individually listable and revocable; logout revokes the current session, and logout-all revokes all of the user's sessions.

Never store long-lived refresh tokens in browser `localStorage`. Never expose raw refresh values through logs, APIs, analytics, or security events. Account suspension, deletion, password reset, and other security-sensitive state changes must apply the session response defined by their implementation phase; password reset must include an explicit session-revocation policy.

### Verification, recovery, and security responses

Support email verification, forgot-password, and password-reset flows. Verification and reset secrets are cryptographically random, expiring, single-use, and stored protected or hashed. Responses must avoid disclosing whether an account exists. Related persistent changes, including password replacement and required session revocation, are atomic.

Authentication endpoints must use structured errors, request IDs, validation responses, and rate-limit responses without exposing stack traces or secret material. Record security events needed for investigation without recording credentials, raw refresh tokens, production OTPs, or recovery secrets.

## Alternatives considered

- Managed identity as the canonical user store: rejected because the approved architecture requires Outpost-owned authentication and portable domain identity.
- Separate Outpost users for each login method: rejected because it would fragment memberships, progress, and activity for one person.
- Automatic account merging by matching email: rejected because email coincidence or provider metadata is not proof of control of both established accounts.
- OAuth email as the Google identity key: rejected because Google's stable subject is the durable provider identifier.
- Long-lived bearer tokens in browser storage: rejected because rotation, server-side revocation, replay detection, and `HttpOnly` cookie protection are required.
- Self-contained access verification without consulting live session state: initially considered in Phase 0. Phase 6 uses signed 15-minute access JWTs plus database checks of session ownership, expiry, revocation, and active user status. This makes logout and account suspension effective on subsequent requests at the cost of database reads; refresh-session and token-family architecture remains unchanged.

## Consequences

One user can authenticate through multiple methods while retaining one set of memberships, progress, and activity. Explicit linking and collision handling add user-flow and transactional complexity, but prevent unsafe account takeover through implicit merges.

Rotating refresh families require persistent session state, atomic rotation, replay handling, security events, and careful concurrent-request behavior. Short-lived access credentials limit exposure but require refresh and session restoration flows in the frontend.

Provider-neutral SMS and OAuth boundaries preserve the modular-monolith and cloud-independence rules. Authentication storage and flows remain staged across Phases 5–11; this ADR does not implement future phases early.

## Verification and future enforcement

For this documentation task, verify that the record exists, matches Layers 1–2, covers all three authentication methods, preserves one canonical user, defines explicit linking and lockout prevention, records the rotating-session and replay rules, keeps authentication separate from authorization, and is indexed without contradictory architecture.

When implementation exists, security-sensitive behavior requires regression tests, including:

- password registration and login normalization, Argon2id hashing, generic errors, policy limits, and atomic persistence;
- OTP expiration, single use, attempt limit, resend cooldown, rate limiting, E.164 normalization, secret-backed challenge protection, and non-logging of production codes;
- Google `state`, `nonce`, redirect, code exchange, provider validation, and stable-subject resolution;
- explicit linking proof, collision handling, prohibition of email-only merging, and prevention of final-method removal;
- refresh hashing, rotation, token-family replay revocation, concurrent refresh behavior, session listing/revocation, logout, and logout-all;
- verification/recovery token expiry and single use, generic account-existence responses, and the defined password-reset session response;
- proof that authentication never grants a global role or bypasses ADR-002 tenant authorization.

The original Phase 0 record established these acceptance criteria. Phase 6 implements password registration/login, initial sessions, signed access credentials, and current-session logout with regression tests. Refresh rotation, linking, OTP, OAuth, and recovery enforcement remain assigned to their later phases.
