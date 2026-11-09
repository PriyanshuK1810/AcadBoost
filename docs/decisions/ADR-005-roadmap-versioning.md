# ADR-005: Roadmap versioning and publication

Status: Accepted (formalizes the roadmap-versioning architecture approved in Layers 1–2).
Supersession: [ADR-009](ADR-009-roadmap-review-approval.md) supersedes this record's three-state/direct-publication lifecycle. The historical text below is retained; new publication requires submission and atomic approval/publication.
Date: 2026-09-17.
Scope: Phase 0 curriculum version lifecycle, cohort assignment, and progress-identity invariants only.

## Context

Outpost lets coordinators create or import a curriculum, review it, publish it, assign it to a cohort, and improve later editions. Students must see a stable curriculum while tracking progress, and historical progress and analytics must remain interpretable after coordinators revise a roadmap.

A mutable “current roadmap” would silently change the topics underneath existing cohorts and make recorded progress ambiguous. This record follows the [master build prompt](../OUTPOST-MASTER-BUILD-PROMPT.md), the tenant boundary in [ADR-002](ADR-002-organization-tenant-model.md), and authorization enforcement in [ADR-004](ADR-004-tenant-aware-authorization.md). It does not create schema, endpoints, imports, or product code.

## Decision

### Roadmap identity and version snapshots

A `roadmap` is the organization-owned identity and descriptive container for a curriculum. Curriculum structure belongs to a `roadmap_version`, not directly to the roadmap. Each version owns its complete ordered hierarchy:

```text
roadmap
  → roadmap_version
      → phases
          → weeks
              → topics
```

Each version has a `version_number`, status, creator, creation time, and optional publication time. Version numbers are unique within a roadmap, stable after allocation, and never silently reused. Every version is independently understandable as a complete snapshot rather than a runtime overlay on another version.

The hierarchy uses persisted parent relationships and `order_index` values. Tenant scope derives from the version's parent roadmap. All reads and writes apply ADR-004 policies and verify parent-child relationships; possession of a version, phase, week, or topic identifier is not authorization.

### Version lifecycle

Use the approved statuses `draft`, `published`, and `archived`.

- A draft and its nested phases, weeks, and topics are editable by authorized users.
- Publishing is an explicit, authorized operation that validates the complete draft and atomically transitions it to `published` with its publication metadata.
- A published version and its nested curriculum structure are immutable. Corrections or curriculum changes require a new draft/version.
- Archiving is explicit and preserves the version and its immutable content for history, assigned cohorts, progress, activity, and analytics. An archived version is unavailable for new cohort assignments.

Only a draft may be published. Concurrent publication attempts must not create duplicate version numbers or multiple successful transitions. Exact validation rules and transaction/locking mechanics belong to Phase 14, but publication must never expose a partially frozen hierarchy.

Published or archived curriculum history must not be hard-deleted while referenced by cohort assignment, progress, activity, or other retained records. Archiving is a lifecycle state, not deletion.

### Exact cohort assignment

A cohort references one exact `roadmap_version`, and that version must belong to the same organization and be published when selected. The assignment stores the version identity itself, not “latest,” a roadmap-level moving pointer, or a version number resolved again on each read.

Publishing a newer version never changes an existing cohort assignment. Student roadmap reads, progress summaries, topic statistics, and at-risk analytics resolve through the cohort's pinned version. An archived version remains readable for cohorts already assigned to it.

Any future cohort migration to another version must be explicit, authorized, organization-safe, and designed to preserve history. No automatic or silent migration is part of the initial architecture.

### Curriculum identity and per-user progress

`topic_progress` belongs to `(user_id, topic_id)`. Topics belong to one version hierarchy, and no progress state is stored on roadmap, version, phase, week, or topic definitions. No progress row means `not_started`.

Creating a new roadmap version creates a new curriculum snapshot with its own topic identities. Existing progress therefore remains attached to the topics of the version on which it was recorded. Outpost does not infer that similarly named or positioned topics in two versions are the same, and it does not automatically copy or merge progress across versions.

If progress migration or topic mapping is introduced later, it must be explicit, auditable, tenant-safe, and approved as a separate architectural change. It must not rewrite or erase the original progress and activity history.

### Imports and publication

Roadmap imports preserve the approved sequence:

```text
parse → preview → human correction → commit to draft
```

File imports may use storage and workers, but successful parsing never publishes curriculum automatically. Committing reviewed import content creates or updates authorized draft state. Publication remains a separate explicit operation after human review and validation.

Import records, object keys, previews, and committed drafts remain scoped to the roadmap's organization under ADR-002 and ADR-004. A client or worker cannot redirect imported content into another tenant or a published version by substituting identifiers.

### Reads, history, and analytics

Student-facing curriculum reads use the cohort's exact version and may combine its immutable structure with that user's progress. Coordinator version-management reads distinguish drafts, published versions, and archived versions without mutating historical content.

Activity events and analytics continue to reference the actual topic/version history that produced them. Zero-progress students remain visible through cohort enrollment and outer-join aggregation; version immutability ensures that the denominator and topic structure do not change underneath historical analytics.

## Alternatives considered

- One mutable roadmap tree: rejected because edits would alter active cohorts and make historical progress ambiguous.
- Cohorts following the latest version automatically: rejected because assignment must be stable and curriculum changes require deliberate adoption.
- Storing curriculum directly on cohorts: rejected because it would duplicate versions and weaken roadmap reuse and governance.
- Reusing topic identities across versions: rejected because it would make immutable snapshots dependent on mutable shared curriculum records.
- Copying progress automatically to a new version: rejected because topic equivalence cannot be inferred safely and history must remain auditable.
- Publishing immediately after import parsing: rejected because human preview and correction are required before commit, and publication is a separate explicit action.

## Consequences

Immutable published snapshots make cohort delivery, progress, activity, and analytics reproducible. They require additional rows and explicit version-management flows, but avoid hidden curriculum changes and preserve the meaning of historical records.

New versions do not inherit progress automatically. This is intentionally conservative: coordinators can improve curriculum without corrupting prior learning history, while any future migration requires an explicit design.

Archival retains storage and history rather than deleting it. Data-retention and cleanup policies must respect referenced versions and records. The modular monolith and PostgreSQL transaction rules from ADR-001 remain sufficient; no new infrastructure is introduced.

## Verification and future enforcement

Phase 14 implements the chosen workflow: roadmap creation writes draft version 1 with starter topics, coordinators can replace the draft's ordered phase/week/topic tree, and a separate review and publish action validates and freezes it. Copying a published or archived version allocates the next stable number under a roadmap row lock and creates independent hierarchy and topic IDs in a new draft. Draft editing, publishing, and archiving lock the version row. Database triggers reject incomplete publication and direct edits or deletion of published/archived versions and their content. The additive migration leaves existing published version-1 rows and cohort/progress references in place. Existing cohorts can still read and write progress on an archived assigned version; new cohorts require a published version. Imports, cohort adoption, and later analytics are outside Phase 14.

The initial documentation decision required this record to match Layers 1–2 and ADRs 001–004, define draft/published/archived behavior, published immutability, exact cohort assignment, topic-progress identity, import review before publication, tenant boundaries, and correct decision indexing without contradictory architecture.

PostgreSQL-backed migration, API, and integration tests should prove:

- drafts and nested structure can be edited only by authorized organization members;
- publishing validates and atomically freezes a complete version, assigns stable version metadata, and handles concurrent attempts safely;
- published and archived structure cannot be mutated through direct or nested endpoints;
- cohorts accept only an exact published version from the same organization and never move when a newer version is published;
- archived versions reject new assignments while remaining readable for existing assigned cohorts and history;
- topics in a new version receive independent identities and existing user progress/activity remains attached to the original version;
- imports require preview and human correction before draft commit and never publish automatically;
- student reads, zero-progress analytics, and topic statistics use the cohort's pinned version and exclude other organizations.

Phase 14 verifies draft edits, publication, concurrent transition, direct content mutation denial, version-copy identity, archival behavior, tenant and role checks, and a pre-migration version-1 fixture. Import and later analytics cases remain acceptance criteria for their respective phases.
