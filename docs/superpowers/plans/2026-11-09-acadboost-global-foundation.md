# Acadboost Global Foundation Implementation Plan

> **For agentic workers:** Use the superpowers:executing-plans skill to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Establish Acadboost as the frontend display brand and extend the approved forest-and-sage baseline with shared interaction and responsive conventions.

**Architecture:** Keep `design-tokens.css` as the sole root token source. Add a small shared wordmark component, import global interaction rules through the existing CSS entry, and update existing page-family styles without changing route or API behavior.

**Tech Stack:** React, React Router, CSS, Vitest, Testing Library, Vite.

**Spec:** User-pasted `ACADBOOST — UI-GLOBAL-01` implementation brief; `docs/design/OUTPOST_DESIGN_BASELINE.md`.

## Global Constraints

- Do not rename internal identifiers, routes, API contracts, package IDs, cookies, or storage keys.
- Do not modify backend source, database records, or authorization behavior.
- Do not add dependencies, implement the future homepage redesign, or commit/push.
- Preserve the existing working tree and prior verification artifacts.
- Keep the approved Roadmap Versions visuals and mobile selector.

## Review Focus

- Wordmark accessible name and visual rendering across public, auth, review, and workspace shells.
- Brand updates preserve functional route destinations and auth/session behavior.
- Shared button, field, card, dialog, and feedback rules do not override existing state semantics.
- Reduced motion removes movement while keeping status changes understandable.
- Responsive width and 200%-equivalent layouts do not introduce document overflow.

### Task 1: Shared Acadboost wordmark

**Files:** Create `frontend/src/app/BrandWordmark.jsx` and its focused test; modify existing shared brand locations and frontend title.

- [ ] Test the accessible name, punctuation, link semantics, and non-link rendering.
- [ ] Replace duplicated public, auth, review, and workspace display wordmarks with the component.
- [ ] Update user-visible product text to Acadboost; retain internal names and identifiers.
- [ ] Run focused brand/auth/shell/review/version tests.

### Task 2: Interaction and responsive foundation

**Files:** Modify `frontend/src/app/design-tokens.css`, `frontend/src/index.css`, `frontend/src/styles/public-pages.css`, and `frontend/src/app/workspace.css`.

- [ ] Add shared motion duration/easing tokens and fluid content gutters.
- [ ] Align button/interactive-card, focus, disabled, form, and dialog conventions with shared tokens.
- [ ] Keep static cards non-interactive and preserve all existing behavior.
- [ ] Test reduced-motion styles and existing lifecycle/dialog behavior.

### Task 3: Design baseline and brand dependency inventory

**Files:** Update `docs/design/OUTPOST_DESIGN_BASELINE.md`; keep its historical filename.

- [ ] Document Acadboost brand rules, token source, interaction standards, motion, responsive and accessibility requirements, artwork guidance, and page contracts.
- [ ] List backend-generated brand references that remain outside frontend scope.
- [ ] Document future homepage redesign as deferred.

### Task 4: Verification and evidence

- [ ] Run requested focused tests and the full reduced-concurrency frontend suite.
- [ ] Run lint, production build, and `git diff --check`.
- [ ] Inspect the app at 320, 375, 430, 768, 1024, 1440, and 1920 CSS-pixel widths, plus an explicitly labeled 200%-equivalent 720px layout at 1440px baseline.
- [ ] Capture accessible live pages and record workspace/backend limitations honestly.
- [ ] Save screenshots and the verification report outside the project folder.
