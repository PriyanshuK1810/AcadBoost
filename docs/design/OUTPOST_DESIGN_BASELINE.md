# Acadboost Global Design Baseline

**Product brand:** Acadboost  
**Status:** Approved global implementation baseline  
**Scope:** Frontend brand, visual tokens, shared interactions, and responsive rules  
**Canonical tokens:** [`frontend/src/app/design-tokens.css`](../../frontend/src/app/design-tokens.css)

> This file keeps its historical `OUTPOST` filename for compatibility with existing references. The public-facing product name is Acadboost.

## 1. Design direction

Acadboost is a collaborative academic learning workspace for students, faculty, coordinators, mentors, and administrators. The shared design combines forest green, sage, warm off-white surfaces, and readable slate/forest typography. Layered mountain and pine artwork supports the identity without competing with academic content. Frosted glass is limited to navigation and contextual bars; forms, editors, and dense information cards remain clear and high contrast.

The baseline favors clarity and predictable navigation while keeping a friendly, energetic character. Keep the approved Roadmap Versions proportions, lifecycle badge contrasts, mobile selector, and forest illustration behavior intact when changing shared styles.

## 2. Brand usage

- The canonical public-facing name is **Acadboost**, with this capitalization.
- The optional tagline is **Learning Workspace**.
- Use [`frontend/src/app/brand.js`](../../frontend/src/app/brand.js) for repeated brand text.
- Use [`frontend/src/app/BrandWordmark.jsx`](../../frontend/src/app/BrandWordmark.jsx) for the accessible text wordmark. Use the existing `wordmark`, `workspace-brand`, or `workspace-logo` class to preserve the context-specific presentation.
- The current wordmark is original text with a decorative period; no remote logo, font, or image dependency is needed. Keep the text readable on both light and dark surfaces.
- Use the canonical brand in user-visible copy, accessible names, error messages, and page metadata. Avoid repeating it where it adds no clarity.
- Do not use generated screenshot art as a page background or imply that illustrative roadmap content is live functionality.

### Legacy naming policy

Keep `docs/design/OUTPOST_DESIGN_BASELINE.md` at its current path because existing materials reference it. Preserve historical ADRs, reports, migrations, routes, package identifiers, environment variables, API names, cookies, and storage keys as written. The display-brand update does not rename infrastructure.

Frontend review and test descriptions may retain the former name when they are historical/internal labels rather than visible product copy. Backend-generated communications and identity fallbacks are separate migration work and must not be changed as part of a frontend-only task.

### Known backend brand dependencies

The following backend-generated strings still contain the former display name and are intentionally outside the frontend change scope:

- `backend-js/src/modules/auth/recovery.js`: email verification and password reset subjects and message copy.
- `backend-js/src/modules/auth/phone.js`: phone login SMS copy and the fallback display name `Outpost member`.
- `backend-js/src/modules/auth/google.js`: the fallback display name `Outpost member`.
- `backend-js/src/app.js` and `backend-js/src/server.js`: technical API name and server log labels; these are operational identifiers rather than browser-facing brand copy.

Do not report the entire product as rebranded until server-generated email/SMS and fallback identity copy have been addressed in an authorized backend task.

## 3. Shared implementation and canonical tokens

The design token file is imported once from [`frontend/src/main.jsx`](../../frontend/src/main.jsx), before the global stylesheet and route styles. It is the only global `:root` palette. Do not add route-level root palettes or copy tokens into component CSS.

| Concern | Canonical token group | Examples |
| --- | --- | --- |
| Brand and surfaces | `--color-*` | `--color-forest: #174f40`, `--color-forest-deep: #103d32`, `--color-sage: #eef3ed`, `--color-sage-accent: #d8eeaa`, `--color-canvas: #fafbf8`, `--color-surface: #fff` |
| Text, borders, actions | `--color-*` | `--color-text-primary: #203c34`, `--color-text-secondary: #50635b`, `--color-text-muted: #61746a`, `--color-border: #dce5dc`, `--color-focus: #398369`, `--color-primary-action: #1d5944` |
| Lifecycle | `--status-{state}-*` | Keep draft, review, published, and archived text/fill/border values paired. |
| Typography | `--font-*`, `--font-size-*`, `--line-height-*` | Shared system font stack and body/heading scales. |
| Spacing and responsive gutters | `--space-*`, `--page-gutter`, `--content-width` | 4px spacing base, fluid page gutters, 1160px reading width. |
| Geometry and elevation | `--radius-*`, `--shadow-*`, `--border-width-*` | Shared control/card/panel/dialog radii and focus/floating shadows. |
| Motion | `--motion-*` | Fast 140ms, standard 220ms, deliberate 320ms; shared easing curves. |
| Workspace shell | `--workspace-*`, `--glass-*` | Forest shell colors, sage selection, restrained navigation glass. |

The existing `--ink`, `--forest`, `--paper`, and related names remain compatibility aliases. New styles should use semantic `--color-*` tokens. Promote a repeated exception to a semantic token instead of repeating a raw value across stylesheets. One-off illustration colors may stay local to the artwork.

## 4. Shared file map

| Responsibility | File |
| --- | --- |
| Canonical brand strings | [`frontend/src/app/brand.js`](../../frontend/src/app/brand.js) |
| Shared text wordmark | [`frontend/src/app/BrandWordmark.jsx`](../../frontend/src/app/BrandWordmark.jsx) |
| Root tokens | [`frontend/src/app/design-tokens.css`](../../frontend/src/app/design-tokens.css) |
| CSS import entry | [`frontend/src/main.jsx`](../../frontend/src/main.jsx) |
| Global reset, focus, interactive-card convention, and reduced motion | [`frontend/src/index.css`](../../frontend/src/index.css) |
| Public and authentication route styles | [`frontend/src/styles/public-pages.css`](../../frontend/src/styles/public-pages.css) |
| Shared workspace shell and controls | [`frontend/src/app/workspace.css`](../../frontend/src/app/workspace.css) |
| Review pages | [`frontend/src/features/review/ReviewPage.css`](../../frontend/src/features/review/ReviewPage.css) |
| Reusable forest illustration | [`frontend/src/features/workspace/components/ForestLandscapeArtwork.jsx`](../../frontend/src/features/workspace/components/ForestLandscapeArtwork.jsx) |
| Shared workspace shell | [`frontend/src/features/workspace/components/WorkspaceShell.jsx`](../../frontend/src/features/workspace/components/WorkspaceShell.jsx) |

## 5. Interaction conventions

### Buttons and links

- Use existing primary and outline button classes. Preserve real button/link semantics and route destinations.
- Default, hover, pressed, focus, disabled, and loading states should be visually distinct without changing control dimensions.
- Use motion tokens for color, border, shadow, and transform transitions. Apply hover-only effects only on hover-capable pointers; keep touch feedback immediate and non-sticky.
- Disabled actions remain legible and use native `disabled` where appropriate. Busy actions keep their existing status text and behavior.
- Keep keyboard focus visible. Focus must not depend on hover.

### Cards

- Existing static cards remain static: no pointer cursor, hover elevation, click handler, or false button semantics.
- For a real interactive card, use a link or button and opt it into the shared `.interactive-card` treatment. It adds restrained border/elevation feedback and visible keyboard focus.
- Preserve clear selected states where the card represents a selected version or step.

### Forms and feedback

- Preserve existing form validation and authentication behavior; do not add validation rules.
- Use associated labels, native required semantics, and existing `form-message` / `form-error` feedback with `status` / `alert` semantics.
- Mark required fields visually while retaining native required attributes. Style explicit `aria-invalid` state without inventing validation.
- Keep focus, error, success, disabled, and submission feedback aligned with shared tokens.

### Dialogs and menus

- Preserve native `<dialog>` and existing menu/drawer behavior. Standardize radius, backdrop, surface, width, spacing, and action placement through tokens.
- Maintain Escape handling, keyboard focus, and return of focus to the trigger where currently implemented.
- Keep menus and dialogs usable at narrow widths; do not replace working behavior solely for styling.

## 6. Motion and accessibility

- Use CSS transitions for simple interaction feedback. Avoid `transition: all`, constant animation, scroll hijacking, and large page transforms.
- Motion communicates hover, selection, opening, or progress states. Do not hide important information behind animation.
- [`frontend/src/index.css`](../../frontend/src/index.css) honors `prefers-reduced-motion: reduce`, removes unnecessary transitions and animation, disables smooth scrolling, and removes decorative hover/press translation.
- Maintain WCAG AA text contrast, visible keyboard focus, semantic headings and controls, and accessible labels. Color is never the only state signal.
- Support text zoom and browser zoom without clipping controls or hiding content.

## 7. Responsive foundation

Use fluid containers, grid/flex layouts, wrapping headings, and the shared `--page-gutter`. Do not conceal defects with document-level overflow hiding. Keep component-level horizontal scrolling explicitly labeled when a wide data table requires it.

Verify actual rendered layouts at **320, 375, 430, 768, 1024, 1440, and 1920 CSS pixels**, plus 200% browser zoom. These are review widths, not mandatory breakpoints. Check navigation, content width, form fields, dialogs, button wrapping, and horizontal overflow. Preserve the Roadmap Versions mobile selector and current responsive workspace drawer.

At desktop, maintain balanced columns and a sensible reading width. At tablet, prevent narrow cards and overlapping actions. At mobile, prioritize readable content, touch targets, and navigation access.

## 8. Forest artwork

Reuse [`frontend/src/features/workspace/components/ForestLandscapeArtwork.jsx`](../../frontend/src/features/workspace/components/ForestLandscapeArtwork.jsx) for public hero sections, restrained workspace headers, selected onboarding moments, and occasional empty states where it helps orientation. Keep it decorative, low contrast behind content, responsive, and `pointer-events: none`. Preserve its accessibility hiding semantics and unique SVG IDs. Do not install illustration packages or add it to every page. Dense editors, tables, and forms prioritize information clarity.

## 9. Page design contracts

These describe future direction; they do not authorize a dashboard redesign or new functionality.

- **Public homepage — future UI-HOMEPAGE-01:** scenic hero, selectable learning stages, expandable cycle explanations, interactive illustrative roadmap, smooth in-page navigation, and responsive storytelling. Do not implement this redesign in the global foundation task.
- **Authentication:** trustworthy forms, accessible validation, visible loading/error states, responsive layout, and Acadboost branding. Preserve authentication/session behavior.
- **Student workspace:** learning progress, roadmap navigation, topic details, milestones, and relevant actions using backend data.
- **Coordinator workspace:** roadmap/cohort management, version status, clear actions, and review-submission feedback while preserving role restrictions.
- **Owner/Admin workspace:** approval and governance visibility, accessible confirmation, rejection feedback, and clear permission boundaries. Do not implement pending approval workflows here.
- **Mentor workspace:** existing supported mentoring activity and learner context; do not invent capabilities.
- **PDF import and roadmap editing:** clear progress and validation feedback, reliable editing, and safe submissions; do not change document processing.
- **Analytics:** readable metrics, accessible charts, responsive tables, and meaningful supported filters; never fabricate statistics.

## 10. Future task instructions

For future Acadboost frontend work:

1. Read this baseline and inspect the current shared shell before changing page styles.
2. Use `brand.js`, `BrandWordmark`, and semantic design tokens instead of repeating brand strings or colors.
3. Add route-family layout rules only to the existing stylesheets listed above; do not create a competing palette or duplicate global import.
4. Preserve routes, role restrictions, authentication, API contracts, and established roadmap workflows unless the task explicitly authorizes a behavior change.
5. Check keyboard, touch, reduced-motion, and responsive behavior. Capture real application screens for visual verification and state any backend/access limitations.
6. Keep homepage redesign, dashboard redesign, and approval/rejection features scoped to their own approved tasks.

## 11. Change control

Changes to the shared brand, root tokens, global type, motion, glass treatment, or shell affect multiple routes and require cross-route review. Preserve existing forest artwork, lifecycle contrast, selected-version treatment, and responsive controls. Keep backend behavior and API contracts outside this frontend design baseline.
