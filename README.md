# SchoolPulse

Turn school data into decisions. Users enter facts; SchoolPulse calculates meaning.

This repository was started from a school-dashboard tutorial template. That code is kept, untouched, under the git tag
`legacy-lama-template` for reference only. Nothing from it is the foundation of SchoolPulse.

## What exists today (Slice 1)

A teacher opens **Today**, takes the **Grade 7A register** with no internet, sees **Offline, 1 waiting**, and when the
connection returns it **syncs**. The **head's overview** then shows the updated attendance, with the raw counts behind
every number.

Not built yet, on purpose: assessments, homework, finance, communication, interventions, workflows, reports, AI, parent
and student experiences. See `docs/ARCHITECTURE.md` for how they will slot in.

## Layout

```
apps/web          Vite + React + TypeScript PWA (React Router, Tailwind, Dexie, React Hook Form)
apps/api          Cloudflare Worker (Hono): thin routes -> services -> Store interface
packages/domain   Pure TypeScript rules: attendance maths, conflict decision, authorization policy, dates
packages/contracts zod schemas shared by web, API and sync
packages/sync     Pure TypeScript: offline operation queue, replica rules, sync status
packages/db       SQL migrations, PostgresStore, dev seed data, test support
docs/             Architecture decisions
```

Dependencies point one way: `web`/`api` -> `sync` -> `contracts` -> `domain`; `api` -> `db` -> `domain`.

## Run it locally

Requires Node 22.18 or newer and Docker (for PostgreSQL).

```bash
npm install
npm run db:up                         # PostgreSQL 16 in Docker
export DATABASE_URL=postgres://schoolpulse:schoolpulse@localhost:5432/schoolpulse
npm run db:migrate
npm run db:seed:dev                   # fictional "Mavambo Academy"; refuses to run when ENVIRONMENT=production
```

Create `apps/api/.dev.vars` with a long random secret (never commit it):

```
AUTH_SECRET=replace-with-at-least-32-random-characters
```

Then, in two terminals:

```bash
npm run dev:api     # Worker on http://localhost:8787 (uses wrangler's localConnectionString for Hyperdrive)
npm run dev:web     # PWA on http://localhost:5173, proxying /v1 to the Worker
```

Sign in as `chipo@mavambo.example` (teacher) or `head@mavambo.example` (head). The password is printed by the seed script
(default `schoolpulse-dev`). To see offline mode: open the register, switch the browser to offline in DevTools, mark
and save, then go back online.

## Tests

```bash
npm test                 # domain, contracts, sync: always run. API + database: run when PostgreSQL is configured.
npm run typecheck
npm run check:imports    # works without installing anything
```

Database and API tests need a PostgreSQL the `psql` command can reach, and a role that can create databases:

```bash
export PSQL_TEST_CONN="host=localhost user=schoolpulse password=schoolpulse dbname=schoolpulse"
npm test
```

Without `PSQL_TEST_CONN` those tests are skipped and say so. If `TEST_DATABASE_URL` is set and the `postgres` package is
installed, the tests use the production database adapter instead of `psql`.

## Deploying

- **Web (Cloudflare Pages, existing project):** root directory = repo root, build command `npm run build:web`, output
  directory `apps/web/dist`, environment variable `VITE_API_URL` = the API's URL.
- **API (Cloudflare Worker):** `npx wrangler hyperdrive create schoolpulse-db --connection-string=...`, paste the id into
  `apps/api/wrangler.toml`, set `ALLOWED_ORIGIN` to the Pages URL, `npx wrangler secret put AUTH_SECRET`, then
  `npm run deploy -w @schoolpulse/api`.
- **Database:** any PostgreSQL 16 reachable from Cloudflare Hyperdrive. Run `npm run db:migrate` against it. Never run the seed.
