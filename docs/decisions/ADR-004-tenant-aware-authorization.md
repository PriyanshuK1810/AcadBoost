# ADR-004: Centralized tenant-aware authorization

Status: Accepted (formalizes the authorization architecture approved in Layers 1–2; initial API role permissions are recorded in ADR-006).
Date: 2026-09-17.
Scope: Phase 0 authorization policy and enforcement boundaries only.

## Context

Outpost authenticates one canonical user through the methods defined in [ADR-003](ADR-003-authentication-model.md), but identity alone does not grant product access. A user may hold different roles in several organizations, and tenant-owned resources may express their organization directly or through a parent chain defined by [ADR-002](ADR-002-organization-tenant-model.md).

Authorization must remain consistent across API endpoints, application operations, background workers, list queries, and analytics. Scattered inline role checks would be difficult to audit and could allow a valid user to cross the organization boundary by substituting an identifier. This record follows the master build prompt and [ADR-001](ADR-001-modular-monolith-cloud-independence.md). It freezes the initial architecture; [ADR-006](ADR-006-organization-membership-management.md) records the Phase 13 role-permission matrix.

## Decision

### Deny by default and enforce on the backend

Every protected operation must authenticate the actor and then explicitly authorize the requested action. Missing policy coverage denies access. Frontend route guards, hidden controls, and organization selection improve user experience but never provide security; the backend application boundary is authoritative.

Authorization evaluates current server-side facts: actor identity and account state, the resource's actual organization, the actor's applicable membership and membership state, the required organization role or resource relationship, and any operation-specific invariant. Client-supplied `organization_id`, role, user ID, cohort ID, or opaque resource ID is input to resolve, never proof of authority.

PostgreSQL remains authoritative. Do not cache authorization facts without measured need and a safe invalidation strategy. A stale frontend or worker payload must not preserve access after the authoritative state changes.

### Central reusable policies

Implement reusable application policies with the responsibilities approved in Layer 2:

| Policy | Responsibility |
| --- | --- |
| `require_authenticated_user` | Establish a valid current user and reject invalid account/session state |
| `require_organization_member` | Resolve the organization and require an applicable membership state for that user |
| `require_organization_role` | Require membership plus one of the roles explicitly allowed for the operation |
| `require_cohort_access` | Resolve the cohort's organization and require the operation-specific cohort relationship, such as authorized staff access or eligible student enrollment |
| `require_resource_owner_or_privileged_role` | Require record-level ownership or an explicitly privileged organization role, after tenant scope is established |

Policies may compose, but no policy may infer authorization merely because another policy authenticated the user. Resolve organization scope before evaluating an organization role. Resolve resource ownership through persisted relationships, not a caller's claim.

“Resource owner” means the persisted actor relationship for records that carry fields such as `created_by` or `requested_by`; it is distinct from the organization membership role named `owner`. Neither resource ownership nor the organization-owner role permits crossing into another organization.

Roles remain `owner`, `admin`, `coordinator`, `mentor`, and `student`, scoped to one `organization_membership`. Do not put a role on `users` or treat roles as a universal hierarchy. Each operation declares the accepted role set and any additional relationship rules. The initial live-API permission matrix and account-type compatibility rules are specified and tested in ADR-006; future capabilities require their own persisted relationship and explicit policy.

### Resource scope and relationship checks

Determine tenant scope from the stored resource and its ownership chain. Directly scoped records include memberships, roadmaps, cohorts, imports, and activity events. Versions, phases, weeks, topics, enrollments, and progress inherit organization scope through their parents as defined in ADR-002.

Authorization must verify both actor access and resource relationships. In particular:

- A child ID used under a parent route must actually belong to that parent.
- A roadmap version assigned to a cohort must be published and belong to the same organization.
- Cohort access must validate both the cohort's organization and the actor's permitted staff or enrollment relationship for the requested action.
- Self-service progress operations must bind the target user to the authenticated actor; privileged reads require an explicit policy.
- Membership administration must remain within the target organization and must not derive privilege from a role held elsewhere.
- Import review, commit, storage access, and queued work must preserve the requesting organization's scope.

Membership in both organizations does not authorize mixing a parent from one organization with a child from another. Foreign keys and uniqueness constraints protect structural integrity but do not replace caller authorization.

### Query, mutation, and worker enforcement

Apply tenant scope to the data access itself wherever practical, not only to a check performed after an unconstrained query. Individual reads, lists, counts, pagination, mutations, and aggregates must use the same organization boundary. Analytics must include eligible zero-progress students through correct outer-join behavior while excluding every other organization's data.

Application operations own authorization decisions so the same policies can be used by HTTP handlers and worker entry points. HTTP dependencies may resolve authentication and common context, but domain/application operations must not assume that reaching them proves authority. Background jobs carry the actor and resource context needed for validation and recheck current authoritative state before tenant-owned effects.

Related authorization-sensitive mutations remain atomic with their domain changes where required. A pre-check must not permit a later write against a resource whose relevant relationship changed before commit; implementation must use transaction and query patterns appropriate to the operation.

### Errors, observability, and data exposure

Use structured authorization errors with request IDs and no raw stack traces. Distinguish unauthenticated requests from authenticated requests that lack permission. For resources outside the caller's tenant, responses must not reveal sensitive existence or ownership details; the API applies a consistent not-found/forbidden disclosure policy.

Logs and security events may record safe actor, organization, resource, policy, and outcome identifiers needed for investigation. They must not contain credentials, raw session tokens, OTPs, recovery secrets, or unrestricted tenant data. Authorization denials must not be made to disappear by weakening validation or broadening accepted roles.

## Alternatives considered

- Route-local role checks: rejected because duplicated logic drifts and misses indirect resource and worker paths.
- Global roles on `users`: rejected because authority differs by organization and violates ADR-002.
- Client-selected organization context as authorization: rejected because frontend state and request identifiers are untrusted.
- Role checks without resource relationships: rejected because an allowed role could still combine resources across organizations or act on another user's record.
- Frontend-only protected routes: rejected because frontend guards provide user experience, not security.
- Database row-level security as the only control: not selected as the initial authorization architecture; application policies remain required. Additional database defense may be evaluated later without replacing policy and regression tests.

## Consequences

Central policies create one auditable vocabulary for authorization and reduce drift between modules. They also require every operation to declare its tenant, role, ownership, and relationship needs rather than relying on implicit access.

Scoped queries and relationship checks add joins and testing work. This cost is required for tenant correctness and must be measured before any optimization or caching. PostgreSQL constraints strengthen integrity, while application policies retain responsibility for actor authorization.

The record freezes the enforcement model. ADR-006 supplies the initial application role matrix without adding capabilities that Layer 2 has not approved.

## Phase 13 verification and future enforcement

Phase 13 adds PostgreSQL-backed API tests in `backend-js/tests/db/authorization.test.js` for allowed and denied roles, account-type and membership-role mismatch, active enrollment, cross-organization selectors, mismatched cohort/version/topic parents, and revoked access for an existing token after account suspension. Authentication is checked against the current PostgreSQL account and session on every request.

As additional product modules are introduced, add PostgreSQL-backed API and integration regression tests proving:

- every protected operation denies unauthenticated, missing-membership, disallowed-membership-state, and disallowed-role cases;
- a role in organization A grants no authority in organization B, including when the user belongs to both;
- substituted organization, membership, cohort, roadmap, version, topic, enrollment, progress, import, and activity identifiers cannot cross tenant or parent boundaries;
- self-service and privileged operations enforce the intended actor/target relationship;
- lists, pagination, counts, analytics, storage operations, and background jobs preserve the same tenant boundary as individual HTTP reads and writes;
- authorization changes are honored from authoritative state and cannot be bypassed by stale frontend, cache, or job context;
- frontend guards never substitute for backend denial and error responses do not disclose protected cross-tenant details.

These remaining acceptance criteria apply as import, storage, activity, and worker modules are implemented; Phase 13 does not claim those future paths exist.
