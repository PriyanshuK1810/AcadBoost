# Outpost

Outpost is a portable modular monolith for guided learning and career readiness. Authentication is implemented. A live coordinator-to-student workflow now stores organizations, published roadmaps, cohorts, enrollment, and topic progress in PostgreSQL. The separate review scenario still contains illustrative peers.

## Prerequisites

- Node.js 24.15+ LTS or Node.js 26+ with npm
- Docker for the local PostgreSQL, Valkey, MinIO, and Mailpit services

## Start locally

With Docker Desktop running and dependencies installed in `backend-js/` and `frontend/`, start all local services and both development servers from the repository root:

```powershell
npm run dev
```

Open `http://localhost:5173`. The API runs at `http://127.0.0.1:8000`. Press Ctrl+C to stop the API and frontend. Docker services keep their data and continue running; stop them later with `npm run services:down`.

For a new checkout, create the ignored root and `backend-js/.env` files from their examples, run `npm ci` in each application folder, and run `npm run db:generate` in `backend-js/` once.

## Node backend

Set `OUTPOST_DATABASE_URL` and the authentication settings from `backend-js/.env.example` in the ignored `backend-js/.env` file. The API and Prisma CLI accept the legacy Psycopg URL form. From `backend-js/`:

```powershell
npm ci
npm run db:generate
npm test
npm run dev
```

`npm start` starts the server without watch mode. Both commands use port 8000 by default. Operational endpoints are `/health` and `/ready`; product APIs remain under `/api/v1`.

## Database migrations

Run `npx prisma migrate status` from `backend-js/` to inspect migrations. Use the versioned migrations for schema changes. See the coordinated rollout requirements in [ADR-009](docs/decisions/ADR-009-roadmap-review-approval.md).

For integration verification, run `node scripts/verify-roadmap-review.mjs --full` from `backend-js/` with the local Compose services running. The harness provisions disposable resources and prints the path to its reports in the system temporary directory. Use `T04C_OUTPUT_DIR` to set a different report location.

## Frontend

Run the frontend setup and quality gate from `frontend/`:

```powershell
npm ci
npm run format:check
npm run lint
npm test
npm run build
```

Use `npm run dev` to start Vite. Its `/api` proxy targets the active Node API at port 8000. Copy `frontend/.env.example` to `frontend/.env` when a local override is needed.

## Local PostgreSQL

Copy the root environment example once, then start and verify PostgreSQL from the repository root:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --detach postgres
docker compose ps postgres
docker compose exec --no-TTY postgres pg_isready -U outpost -d outpost
docker compose exec --no-TTY postgres psql -U outpost -d outpost -c "SELECT current_database(), current_user;"
```

PostgreSQL is exposed to the host at `127.0.0.1:5433` by default so it can coexist with a native PostgreSQL installation. Override `POSTGRES_PORT` in the root `.env` file when another host port is required.

Create `backend-js/.env` from `backend-js/.env.example` for a new installation and set the local PostgreSQL URL there. This file is ignored by Git.

Stop the Compose stack with `docker compose down`. Named volumes preserve service data between container recreations; use `docker compose down --volumes` only when intentionally deleting all local service data.

## Local Valkey

Start and verify the Redis-compatible Valkey service from the repository root:

```powershell
docker compose up --detach --wait valkey
docker compose ps valkey
docker compose exec --no-TTY valkey valkey-cli ping
```

Valkey uses append-only persistence in the `valkey_data` named volume. `docker compose down` preserves this data; `docker compose down --volumes` deletes it intentionally.

## Local MinIO

Start and verify the S3-compatible object-storage service from the repository root:

```powershell
docker compose up --detach --wait minio
docker compose ps minio
Invoke-WebRequest http://127.0.0.1:9000/minio/health/live
```

The S3 API is available at `http://127.0.0.1:9000`, and the browser console is available at `http://127.0.0.1:9001`. Sign in with `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from the root `.env` file. MinIO stores objects in the `minio_data` named volume.

For PDF imports, configure `OUTPOST_OBJECT_ENDPOINT` and `OUTPOST_OBJECT_BUCKET` in `backend-js/.env`. Set `OUTPOST_OBJECT_ACCESS_KEY` and `OUTPOST_OBJECT_SECRET_KEY` to the local MinIO user and password. The development API creates the private bucket on startup if it is missing.

## Local Mailpit

Start and verify the local SMTP capture service from the repository root:

```powershell
docker compose up --detach --wait mailpit
docker compose ps mailpit
Invoke-WebRequest http://127.0.0.1:8025/readyz
```

Applications can send unauthenticated development email to `127.0.0.1:1025`. Inspect captured messages in the browser at `http://127.0.0.1:8025`. Mailpit stores captured messages in the `mailpit_data` named volume.

## Container foundations

The current Compose file starts PostgreSQL, Valkey, MinIO, and Mailpit. The Node API and Vite run locally during development. The frontend image builds the static JavaScript app. Build either image from the repository root so the root `.dockerignore` applies:

```powershell
docker build --file backend-js/Dockerfile --tag outpost-backend-js:local .
docker build --file frontend/Dockerfile --tag outpost-frontend:local .
```

The Node backend image runs Express on port 8000. The frontend image serves the static application with Nginx.

## Architecture records

Architecture decision records are in [`docs/decisions/`](docs/decisions/).
