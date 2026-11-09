# ADR-001: Modular monolith and cloud independence

Status: Accepted (formalizes architecture already approved in Layer 4).
Date: 2026-09-17.
Scope: Phase 0 architecture only.

## Context

Outpost must run locally without AWS and later deploy to a cloud provider without rewriting domain logic. The master build prompt, Layers 1–3, governs this decision. This record documents the approved architecture; it does not start Phase 1.

## Decision

### Modular monolith

Build one cohesive backend with explicit modules for users, authentication, organizations, cohorts, roadmaps, progress, analytics, and imports. Modules expose application operations; callers must not bypass another module's rules by modifying its internal state directly. Related persistent changes remain atomic within PostgreSQL transactions.

HTTP handlers invoke application operations through the `/api/v1` API. Slow work moves through `JobQueue` to worker processes that reuse application and domain logic. Separate API and worker processes remain part of the modular monolith, not independently owned microservices.

The current JavaScript implementation places business behavior in `backend-js/src/modules/`, shared infrastructure in `backend-js/src/core/` and `backend-js/src/db/`, and runtime configuration in `backend-js/src/core/config.js`. Add provider adapters and workers within this modular boundary when their features are implemented.

### Provider boundary and dependency direction

Domain/application logic depends on provider-neutral interfaces. Concrete infrastructure adapters implement these interfaces. Startup wiring selects and injects adapters using runtime configuration; business operations must not instantiate SDK clients or select providers.

| Interface | Responsibility | Planned local implementation |
| --- | --- | --- |
| `ObjectStorage` | Store/retrieve objects using application-owned identifiers | MinIO/S3-compatible adapter |
| `SmsProvider` | Deliver authentication messages | Development SMS adapter |
| `EmailProvider` | Deliver application email | Mailpit adapter |
| `JobQueue` | Submit background work | Redis-backed implementation |
| `Cache` | Reconstructible cached data with explicit invalidation | Redis-compatible implementation, only after measurement justifies caching |

Contracts must be importable without concrete provider packages. Choose signatures and exact placement when the owning phase needs them; do not build speculative interfaces now.

AWS, GCP, and Azure SDKs, provider-specific payloads, endpoints, credentials, storage details, and queue APIs belong in adapters and deployment/configuration wiring. Translate provider responses and exceptions into application-owned values and errors. Provider types must not leak through interface signatures into domain/application logic.

For example, an import operation stores an object key and submits work through `JobQueue`; it does not construct an S3 client or interpret AWS SDK exceptions. An S3-compatible SDK may be used inside a storage adapter only.

Google OAuth/OIDC remains the approved identity integration. Provider protocol handling belongs at the OAuth integration boundary; Outpost owns canonical users, sessions, and authorization.

### State and execution

PostgreSQL is canonical in development, integration testing, staging, and production. Portability concerns its hosting, not replacement with SQLite or arbitrary database engines. Prisma Migrate owns schema evolution after the verified baseline of the existing PostgreSQL database. Do not introduce database-per-tenant storage.

Persistent data belongs in PostgreSQL and object storage. API and worker containers must not rely on container-local durable files. Redis-compatible infrastructure may hold ephemeral/distributed state. PostgreSQL remains authoritative; cached data must be reconstructible and have an invalidation strategy.

Both HTTP and worker execution preserve organization-scoped access and atomic domain operations. `Organization` is the tenant boundary; roles belong to memberships, never globally to users. Detailed tenant, authentication, authorization, and roadmap-versioning decisions remain separate Phase 0 work.

### Deployment portability

Local infrastructure will use Docker Compose, PostgreSQL, Redis/Valkey, MinIO, and Mailpit as their phases arrive. Core local operation must not require AWS infrastructure or AWS credentials.

Production uses frontend/CDN, API containers, worker containers, PostgreSQL, a Redis-compatible service, object storage, TLS, secrets, and logging. AWS is a later deployment target. The approved potential mapping includes ECS/Fargate, RDS, ElastiCache, and S3; it does not change domain logic.

Moving providers may require adapter changes, configuration, secret provisioning, data migration, and operational verification. Preserve domain rules and product API behavior without a domain rewrite. Portability does not mean migration is automatic or already tested.

## Alternatives considered

- Initial microservices: deferred because distributed operations, network failures, and transaction coordination add complexity before measured need.
- Direct cloud SDK calls in business operations: rejected because provider behavior and types would spread into domain/application logic.
- Unstructured monolith: rejected because shared deployment alone does not protect module responsibilities.
- Abstract every technology: rejected because PostgreSQL and the chosen application stack are intentional; provider interfaces do not promise arbitrary framework or database replacement.

## Consequences

Local and cloud deployments share business behavior and ordinary database transaction boundaries. Interfaces support application tests with substitutes and separate adapter integration tests when code exists.

Contracts, adapters, and startup wiring add work. Provider semantic differences require explicit handling and verification. Modules share backend releases and a database; independent module deployment and complete failure isolation are not initial capabilities.

Do not introduce premature Kubernetes, Kafka, service mesh, event sourcing, ubiquitous CQRS, additional database technologies, or active-active multi-region infrastructure. Later service extraction or boundary changes require evidence and a subsequent approved decision.

## Verification and enforcement

For this ADR, review consistency with Layers 1–3, interface coverage, dependency direction, state placement, and deployment portability. Check documentation links and confirm that no application scaffolding is created.

When implementation exists, reviews and appropriate automated checks must verify module imports, absence of leaked provider types, adapter contracts, local operation without AWS infrastructure, tenant authorization, and transactions across API/worker paths. Runtime portability is not verified by this documentation task.
