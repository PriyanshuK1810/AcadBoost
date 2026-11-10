# Roadmap Versions Master Verification Report

**Run date:** 2026-11-09  
**Repository:** `D:\Shared Workspace\Projects\Outpost-New`  
**Branch / HEAD:** `main` / `ad6383aeeb85744b62902fc00c3c44bc02649f7e`  
**Target:** T04-E-03A, T04-E-03B, UI-03A  
**Test identity:** disposable local Coordinator `outpost_ui_acceptance_20261109` (credentials intentionally omitted)

## Executive findings

The local frontend and API are operational. The test Coordinator authenticated, created a disposable organization and two roadmap drafts, saved an edit through the live API, submitted one draft for review, and confirmed that its read-only `in_review` state persisted after reload. The submission confirmation canceled without mutation and then submitted successfully once confirmed.

The main live defect found is that the page exposes **Copy as new draft** for an `in_review` source. The backend only permits copy from `published` or `archived` sources, so the live request receives HTTP 409. The page presents recovery guidance and does not retry automatically. Approval is outside this verification scope, so a successful copy and live archive could not be demonstrated safely.

The implementation generally follows the reference palette and card language. The strongest visual gap is the forest landscape: on desktop, the live header shows only a pale, narrow section at the far right rather than the broad mountain-and-forest sweep in the approved reference. At the mobile viewport, the version selector is present and the measured document has no horizontal overflow.

## Repository and environment

- Initial review baseline was `main`, HEAD `7976fee21754d783a11c82a0938f07ba1a30f2d6`, with frontend and schema changes present. The user then committed the frontend roadmap work and separately committed schema work. Current HEAD is `ad6383aeeb85744b62902fc00c3c44bc02649f7e`.
- At report time the working tree had no uncommitted changes before this report was added. No backend or database source was changed for verification.
- Node.js: v26.7.0; backend requirement: Node >=24.
- Prisma CLI and client: 7.10.1.
- `npm.cmd exec prisma -- migrate status`: 7 migrations found; database schema up to date.
- `http://127.0.0.1:8000/health`: `healthy`.
- `http://127.0.0.1:8000/ready`: `ready`.
- Frontend `http://127.0.0.1:5173`: HTTP 200.
- PostgreSQL, Valkey, and Mailpit ports were listening locally; Docker service status showed healthy PostgreSQL and Mailpit in the prior live check.

## Live test setup

Created a disposable Coordinator through the app registration form with synthetic `.test` contact information. Signed in through the normal UI, created organization `Outpost UI Acceptance 20261109`, then created:

- `UI Acceptance Roadmap 20261109` (3 topics), submitted to `in_review`.
- `UI Acceptance Draft B 20261109` (2 topics), edited and saved.

These records are local development fixtures. They were not deleted because no safe supported cleanup was verified. The account is retained for future tests; credentials are not included here.

## Live browser and API evidence

| Check | Result | Evidence type / details |
|---|---|---|
| Coordinator sign-up and authentication | PASS | Live browser; account created and reached `/app/coordinator`. |
| Roadmap Versions route | PASS | Live browser route `/app/coordinator/roadmaps/:roadmapId/versions?organizationId=…`. |
| Save Draft | PASS | Live browser + real API; changed a topic, saved, saw “Draft saved”, and authoritative editor returned to Saved. |
| Unsaved changes block submit | PASS | Live browser; after editing, Submit for Review was disabled and Save draft remained available. |
| Submit confirmation / cancel | PASS | Live browser; native `<dialog>`, accessible title/description; focus initially on Cancel; cancel returned focus to trigger and made no mutation. |
| Submit for Review | PASS | Live browser + real API; confirmation made one request, then UI displayed `In review`, read-only content, success feedback, and no Submit action. |
| In-review persistence | PASS | Live browser + real API; reload retained `In review` and read-only content. |
| Copy Version | PARTIAL / DEFECT | Live browser + real API; copying the `in_review` version returned 409 twice (second attempt was explicitly after refresh). No hidden retry occurred. The UI’s Copy action remains available for this lifecycle status, while backend route logic only accepts `published` or `archived`. |
| Archive Version | NOT VERIFIED LIVE | No legitimately published disposable version was available; approval UI is out of scope. |
| Live 409 concurrency between two sessions | NOT VERIFIED | The observed copy conflict is a real 409, but two-session stale-save concurrency was not executed. Mocked frontend conflict tests passed. |
| Role matrix (Owner/Admin/Coordinator/Mentor/Student) | PARTIAL | Coordinator authorization exercised live. Other role visibility is covered by mocked frontend tests; no legitimate local memberships for the other roles were created. Backend remains authoritative. |
| Mobile version selection | PARTIAL | Selector was visible at 375×812; DOM metrics showed `innerWidth=375`, `scrollWidth=360`, selector present, one-column layout, artwork hidden. A second-version selection could not be tested because this roadmap has only one version. |

### Live copy finding

The observed conflict is consistent with backend route rules in `backend-js/src/modules/learning/roadmapRoutes.js`: copy checks source revision and then accepts only `published` or `archived`. The page currently disables Copy only for `draft`, leaving it enabled for `in_review`. This creates a predictable, avoidable 409. Recommended follow-up: disable or hide Copy for `in_review` unless the backend contract is intentionally expanded. That correction was not made during this verification run.

## Design comparison with supplied references

### Matches

- Forest-green workspace navigation and pale green selected navigation state.
- Warm, light workspace background, dark green headings, and sage accents.
- Rounded white version-history and details cards.
- Strong selected-version treatment with green border and pale sage fill.
- Lifecycle badge is distinct in list and details panel; amber `In review` communicates state without relying only on color.
- At 768px and 375px, history/details stack vertically; at 375px the native version selector is visible.
- The dialog uses a white rounded surface, dark-green action button, sage icon field, and dark backdrop, matching the reference direction.

### Differences and improvement proposals

1. **Forest artwork coverage (major visual gap):** The supplied reference uses a broad landscape silhouette spanning most of the page header. The live desktop screenshot showed only a short pale fragment at the far right. Increase the artwork’s visible width/height or revise its source viewBox/crop and blend so the landscape reads across the heading while retaining legible text.
2. **Desktop screenshot composition:** The browser capture at a nominal 1440px viewport showed a narrower captured surface, clipping the far right of the details card in the displayed image. DOM measurements reported `innerWidth=1440`, document `scrollWidth=1425`, editor width about 813px and no horizontal document overflow. Recapture with a full-width browser window before judging card proportions.
3. **Version history density:** The reference shows multiple version cards with metadata and clear spacing. The live fixture has one version, so ordering, card-to-card rhythm, and selected-versus-unselected comparison remain unassessed. Use several legitimately created versions/states for the next visual pass.
4. **Mobile navigation footprint:** The application shell’s dark sidebar occupies substantial screen width at 375px in the capture. Consider a compact/collapsible mobile navigation pattern if that matches the wider product direction; the Roadmap Versions page itself did not overflow horizontally.
5. **Copy lifecycle affordance:** Make Copy unavailable on `in_review` under the current backend contract, or align the backend contract and implementation deliberately. Do not show an enabled action that is known to return 409.
6. **Submission notice:** The amber notice is consistent and readable. Keep its width aligned to the editor card and verify at full-size screenshots; the current viewport capture showed the right edge clipped by the capture surface, not by document overflow.

### Reference verdict

**Partially consistent, with a notable artwork mismatch.** The palette, cards, badges, and selected state follow the reference language. The forest artwork does not yet achieve the reference’s broad visual presence. The mobile selector and no-overflow checks passed at the tested viewport, but detailed full-width screenshot review remains limited by the browser capture surface.

## Accessibility and security observations

- The live confirmation is a native HTML `<dialog>` with `aria-labelledby` and `aria-describedby`. On opening, focus was observed on Cancel; cancel restored focus to Submit for Review. Native modal semantics provide focus containment and backdrop blocking. Escape behavior was not manually tested in the live browser; mocked coverage and source logic cover cancellation.
- Selected version entries expose pressed/selected semantics in the DOM; the tested one-version live view could not demonstrate switching.
- Status is communicated with text and icon as well as color.
- No unsafe HTML rendering or sensitive values appeared in the inspected page. Credentials were excluded from report output.
- No unauthorized submission attempt was made. Non-Coordinator roles were not established for live testing.

## Automated verification

Executed against the current frontend checkout:

- `npm.cmd test -- --maxWorkers=1 --no-file-parallelism` — **16 files passed, 124 tests passed, 0 failed** (Vitest did not report skipped tests).
- `npm.cmd run lint` — passed.
- `npm.cmd run build` — passed (Vite production build).
- `npm.cmd exec prisma -- --version` — Prisma CLI/client both 7.10.1.
- `npm.cmd exec prisma -- migrate status` — schema up to date.

Automated page/API tests use mocks. They are regression evidence, not substitutes for live checks above.

## Acceptance decisions

| Component | Decision | Reason |
|---|---|---|
| T04-E-03A | **Not ready to close** | Live save passed. Live copy hit a lifecycle 409 for an in-review source; successful copy and archive remain unverified due to lack of a published fixture. Two-session stale-save conflict untested. |
| T04-E-03B | **Partially verified; not ready to close** | Coordinator submission, cancellation, read-only state, and persistence passed live. Other role memberships, live 401/403/422, network uncertainty, and two-session behavior remain unverified. |
| UI-03A | **Partially verified; not ready to close** | Live desktop/tablet/mobile views inspected and mobile selector/no-overflow checked. Desktop artwork is substantially narrower than reference; full-width capture and multi-version visual comparison remain outstanding. |

## Remaining work

- Make Copy lifecycle availability agree with the backend’s published/archived-only copy rule.
- Obtain a legitimate published disposable version to verify copy and archive success; this requires the separate approval workflow or an existing safe fixture.
- Exercise archive warning with a disposable published state.
- Run a two-session stale-revision save test.
- Verify Owner/Admin/Mentor/Student roles through legitimate organization memberships.
- Manually test Escape and focus containment in the live dialog.
- Recheck responsive screenshots using a full-width browser capture; compare artwork against the reference and consider broadening its presence.
- Preserve the two clearly named local fixtures and test account for future verification; clean them up only through supported application flows when no longer needed.

## Screenshot evidence

Live desktop, tablet, and mobile screenshots were displayed in the Codex conversation during this verification. They are real browser captures of the local application and are available in the conversation history, but this run did not save those image bytes as repository PNG files. No screenshot package or ZIP is claimed by this report.
