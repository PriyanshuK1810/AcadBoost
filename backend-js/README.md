# Outpost JavaScript API

Node.js 24+, Express 5, Zod, Prisma, PostgreSQL, Valkey, JOSE, and Argon2id.

From this directory, with the root Docker Compose services running:

```powershell
npm ci
npm run db:generate
npm test
npm run dev
```

The API listens on `127.0.0.1:8000` by default. Use `PORT` and `HOST` to change the bind address. `/health` is liveness, `/ready` checks PostgreSQL, and product routes live under `/api/v1`. Vite proxies `/api` to this server.

Create `.env` from `.env.example` for a new setup. Keep database and signing credentials in this ignored file. The API and Prisma CLI read it and normalize a legacy `postgresql+psycopg://` URL if present. Do not commit secrets.

The existing PostgreSQL schema was baselined as `0_baseline`. Run `npx prisma migrate status` to inspect it. Do not use `prisma db push` or reset the existing database. Run `npm run test:db` to verify against a running database.

Google login requires a real OAuth client ID and secret; phone SMS is captured only by the development provider.

Roadmap publication requires an active Owner/Admin membership in the active
organization on both the nested and canonical publish routes. The policy is
checked again inside the publication transaction after acquiring its locks.
Coordinators retain draft creation, editing, copying, and PDF conversion access.
This is the interim AC01 authorization fix, not complete FR-10/T04 compliance:
submission, `in_review`, approval/rejection, and reviewer metadata remain pending.

Apply additive migrations on new or existing databases with `npx prisma migrate deploy`,
then run `npm run db:generate`. Phase 18 adds transactional progress history and
cohort week scheduling without changing published curriculum or existing progress.
See [ADR-008](../docs/decisions/ADR-008-activity-and-cohort-deadlines.md).

Student reads: `GET /api/v1/progress/me/activity` and
`GET /api/v1/progress/me/deadlines`. Staff reads:
`GET /api/v1/cohorts/:cohortId/activity` and
`GET /api/v1/cohorts/:cohortId/deadlines`. Activity accepts `limit` (1–50,
default 25) and a scoped UUID `cursor`, returning `events` and `next_cursor`.
History starts with actual new transitions; legacy completion is not backfilled.

Authorized owners/admins/coordinators schedule with
`PUT /api/v1/cohorts/:cohortId/weeks/:weekId/deadline`, body
`{"due_at":"2026-12-01T17:00:00+05:30","time_zone":"Asia/Kolkata"}`.
The explicit offset defines the instant; the valid IANA zone defines display.
`DELETE` at the same path removes a deadline. Both record append-only audit changes.
The coordinator cohort detail page provides these controls and student activity.
