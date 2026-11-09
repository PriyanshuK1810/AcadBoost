# ADR-002: Organization-based tenant model

Status: Accepted (formalizes the tenant architecture approved in Layers 1–2).
Date: 2026-09-17.
Scope: Phase 0 tenant boundary and isolation invariants only.

## Context

Outpost supports multiple colleges, departments, institutes, companies, and learning communities. A person may participate in more than one organization without becoming a different user. Each organization must control access to its own curriculum, cohorts, imports, activity, and analytics.

A tenant boundary defines which organization's data an operation may access. In Outpost that boundary is `Organization`, not the logged-in user, a cohort, an authentication provider, or the deployment host. This record follows the master build prompt and [ADR-001](ADR-001-modular-monolith-cloud-independence.md); it does not introduce schema, endpoints, or application code.

## Decision

### Canonical users and organization memberships

Keep one canonical `users` record per user. Password credentials, phone identities, OAuth identities, and sessions resolve to that user; authentication alone grants no organization access.

Represent participation through `organization_memberships`, with `organization_id`, `user_id`, `role`, `status`, and `joined_at`. Preserve the unique `(organization_id, user_id)` pair. A user can have separate memberships in multiple organizations, with different roles and membership states in each.

The specified roles are `owner`, `admin`, `coordinator`, `mentor`, and `student`. Roles belong to organization memberships; never put a global authorization role on `users`. A coordinator in organization A gains no coordinator privileges in organization B. Membership is necessary for tenant access but is not sufficient for every operation: applicable role, cohort, and ownership policies must also pass. Detailed role permissions and status transitions belong to the separate authorization decision and implementation phases.

### Shared PostgreSQL model and ownership

Use the canonical PostgreSQL data model within the modular monolith. Tenant records share the application's tables; do not introduce database-per-tenant storage or a different persistent database technology. Isolation is a required application invariant, not a consequence of deploying separate databases.

Follow the ownership already expressed by Layer 2 rather than adding `organization_id` columns to every table in this ADR:

| Record | Source of organization scope |
| --- | --- |
| `organization_memberships` | Direct `organization_id`; connects canonical user to organization |
| `roadmaps`, `cohorts`, `imports`, `activity_events` | Direct `organization_id` |
| `roadmap_versions` | Parent `roadmap_id` → roadmap's organization |
| `phases`, `weeks`, `topics` | Parent chain → roadmap version → roadmap → organization |
| `cohort_enrollments` | Parent `cohort_id` → cohort's organization; `user_id` identifies enrollee |
| `topic_progress` | `topic_id` → topic's roadmap hierarchy → organization; `user_id` identifies whose progress it is |

Organization-level access must not expose unrelated users' credentials or sessions. Conversely, user ownership of a progress record does not bypass access checks for the topic's organization.

Preserve progress uniqueness as `(user_id, topic_id)` and enrollment uniqueness as `(cohort_id, user_id)`. Progress is per user and topic, not per cohort; assigning the same version to multiple cohorts does not create independent copies of that user's topic progress. No progress row means `not_started`, subject to the same tenant and resource access checks. These rules do not authorize access across organizations.

### Request and relationship validation

For every tenant-owned read or write, resolve the authenticated user, establish the target resource's actual organization, validate the user's applicable membership and policy, and constrain the operation to that organization. Organization IDs in paths, bodies, query parameters, or frontend state are selectors, never proof of access. Opaque resource IDs are also not authorization.

For routes such as `/cohorts/{cohort_id}`, `/roadmap-versions/{version_id}`, and `/progress/topics/{topic_id}`, derive organization scope through the resource's ownership chain even though the URL lacks `organization_id`. When a request provides both a parent and child ID, verify their relationship as well as the caller's access. Membership in both organizations does not permit mixing their resources.

Enforce these relationship invariants:

- A cohort can be assigned only an exact published roadmap version from its own organization. Never silently move it to the latest version.
- Enrollment must be organization-safe: the cohort's organization and the enrolling user's organization access must be validated. Enrollment alone must not grant membership or a global role.
- Progress operations validate access to the topic and to the relevant user's progress; a caller cannot choose another user's progress merely by submitting a user ID.
- An activity event's organization must match the associated resource's organization. Related progress and activity changes remain atomic.
- Imports, review, and commit remain in the requesting organization's scope; a client-supplied destination cannot cross the tenant boundary.

Lists, counts, pagination, and analytics must apply the same tenant scope as individual reads and mutations. Cohort analytics must retain eligible zero-progress students while excluding other organizations' data. Frontend route guards and organization selection provide UX, not backend security.

### Workers and infrastructure

Background jobs must retain sufficient organization, actor, and resource context to apply the same application policies when operating on tenant data. A queued identifier is not proof of access; execution must validate the resource's organization and applicable authority rather than relying only on the original HTTP request.

Storage access, import artifacts, and any future caches must preserve organization scope through the provider-neutral boundaries established in ADR-001. Object keys, cached results, and job payloads must not become a way to bypass tenant authorization. This ADR does not select new providers, add caching, or define queue payload schemas.

## Alternatives considered

- Global roles on users: rejected because a user's authority differs between organizations.
- Treating cohorts as tenants: rejected because multiple cohorts, roadmaps, and memberships belong to one organization.
- Client-selected organization as sufficient authority: rejected because it would permit cross-tenant resource access by changing an identifier.
- Database-per-tenant: deferred by the governing architecture; it would add provisioning and migration complexity outside the approved initial model.

## Consequences

One canonical identity can participate in multiple organizations while retaining independent membership roles. Shared PostgreSQL tables keep the initial deployment aligned with ADR-001, but every data-access path must preserve tenant scope, including joins, aggregates, workers, and indirect resource routes.

The ownership hierarchy avoids inventing duplicate tenant fields, while requiring reliable parent relationships and explicit relationship checks. Foreign keys and uniqueness constraints protect structural integrity; they do not replace caller authorization. Exact constraints, query helpers, and any additional database defense such as row-level security must be evaluated in their relevant phases; no unapproved schema or enforcement mechanism is introduced here.

Authentication internals, the full authorization policy matrix, and roadmap publishing/versioning details remain separate Phase 0 decisions. This ADR freezes their tenant boundary without implementing those tasks.

## Verification and future enforcement

For this documentation task, verify file existence, internal consistency, agreement with the governing tenant rules and Layer 2 data model, correct decision-index links, and absence of unrelated architecture or application changes.

When implementation exists, add PostgreSQL-backed regression coverage proving:

- A member of organization A cannot read, mutate, list, or obtain analytics for organization B by substituting an organization, cohort, version, topic, progress, or import identifier.
- A user belonging to both organizations receives only the role and resource access applicable to the selected organization; cross-organization parent/child assignments still fail.
- Missing or disallowed membership denies access, and membership changes cannot be bypassed by stale frontend state or background-job assumptions.
- Two users' progress remains independent, omitted progress remains `not_started`, and zero-progress cohort students remain visible only within authorized analytics.
- Background jobs and storage/cache paths enforce the same ownership and authorization invariants as HTTP operations.

These are future implementation acceptance criteria, not tests claimed to pass in this documentation-only repository. The current task creates only this decision and its index entry.
