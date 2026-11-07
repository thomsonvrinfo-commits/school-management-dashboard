# SchoolPulse runbook

How to run, check, and (when you decide to) deploy SchoolPulse. Written for whoever holds the keys: the platform operator.
Nothing in this file has been done to any live system by the people or tools that wrote the code.

Evidence levels used across the repository: **unit**, **integration** (real PostgreSQL), **render** (React markup, no browser),
**browser** (a real Chromium, `e2e/`), **not verified here**. Anything that has never run in a real browser or on the real
hosting says so.

## 1. On your own computer

Needs Node 22.18 or newer and Docker (for PostgreSQL). `psql` must be on your PATH for the database tests.

```bash
npm install
npm run db:up                                   # PostgreSQL 16 in Docker, port 5432
export DATABASE_URL=postgres://schoolpulse:schoolpulse@localhost:5432/schoolpulse
npm run db:migrate                              # applies packages/db/migrations in order; safe to repeat
npm run db:seed:dev                             # the fictional Mavambo Academy. Refuses to run when ENVIRONMENT=production.
echo "AUTH_SECRET=$(openssl rand -hex 32)" > apps/api/.dev.vars     # never commit this file
npm run dev:api                                 # terminal 1: the API on http://localhost:8787
npm run dev:web                                 # terminal 2: the app on http://localhost:5173
```

Sign in as `chipo@mavambo.example` (teacher) or `head@mavambo.example` (head); the password is printed by the seed (default
`schoolpulse-dev`).

### The checks

```bash
export PSQL_TEST_CONN="host=localhost user=schoolpulse password=schoolpulse dbname=postgres"
npm test                  # unit + real-PostgreSQL tests. Without PSQL_TEST_CONN the database ones are skipped and say so.
npm run typecheck
npm run check:imports     # works without installing anything
npm run check:render      # needs bun
```

`PSQL_TEST_CONN` must be a role that can create databases; each test file makes its own throw-away database and drops it.
Never point it at a database that matters.

To run the same tests through the production database driver (postgres.js) instead of `psql`:

```bash
TEST_DATABASE_URL=postgres://schoolpulse:schoolpulse@localhost:5432/postgres npm test
```

### The browser check

This is the only check that uses a real browser, with the production security headers. It needs the API and a built app:

```bash
# terminal 1: API allowed to talk to the built app's address
cd apps/api && npx wrangler dev --port 8787 --var ALLOWED_ORIGIN:http://localhost:4173
# terminal 2: build the app for that API and serve it with the production headers
VITE_API_URL=http://localhost:8787 npm run build:web && npm run serve:web         # http://localhost:4173
# terminal 3
npx playwright install chromium      # once
npm run e2e
```

It checks that the security policy blocks nothing the app needs (including on a deep link), that a teacher can sign in, and that
a phone holding the current copy of her data is answered "unchanged" instead of downloading everything again. It cannot check
Cloudflare itself (see section 4).

## 2. Automatic checks on GitHub

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, each job on its own throw-away database:

| Job | What it proves | Blocks a merge? |
|---|---|---|
| Tests, types, imports, migrations | all tests with real PostgreSQL; the real migration runner on an empty database, twice | yes |
| Screens render | every screen's real markup passes the accessibility checks | yes |
| The web app builds | the build works, writes the security headers, and **refuses** a bad `VITE_API_URL` | yes |
| Tests through the production driver | the same tests through postgres.js | informational until it has passed once |
| Browser check | the `e2e/` tests above | informational until it has passed once |

The workflow was written without being able to run it. Its first run is its real test; if a failure is about the workflow and not
the code, fix the workflow. After the two informational jobs have passed once, remove their `continue-on-error: true`, and
turn on "require status checks" for the others in the repository's branch protection settings.

There is no `package-lock.json` yet (it could not be created offline). Run `npm install` once on a connected computer, commit
the file it creates, then change `npm install` to `npm ci` in the workflow so every build uses exactly the same versions.

## 3. The platform operator's commands (creating a school and its head)

Heads are never created through the app. The operator does it from a terminal that holds the database address. **Without `--apply`
every command only checks and says what it would do.**

```bash
DATABASE_URL=... node --no-warnings apps/api/scripts/operator.ts create-school --name "Mavambo Academy" --head-email head@school.example
DATABASE_URL=... node --no-warnings apps/api/scripts/operator.ts create-school --name "Mavambo Academy" --head-email head@school.example --apply
DATABASE_URL=... node --no-warnings apps/api/scripts/operator.ts invite-head --school MAV --head-email head@school.example --apply
DATABASE_URL=... node --no-warnings apps/api/scripts/operator.ts reset-head  --school MAV --head-email head@school.example --apply
```

The link it prints is shown once, works once, and is for one person: hand it to the head yourself (WhatsApp, text, in person).
Teachers are invited by the head, from the Staff screen.

## 4. Deploying (only when you decide to)

Order matters: database, then API, then web. Never run the seed on a real database.

**Before anything: take a backup** (see `docs/GOVERNANCE.md`, "Backup and restore") and know how you would restore it.

1. **Database.** Any PostgreSQL 16 reachable from Cloudflare Hyperdrive. For every migration not yet applied, run its pre-flight
   first (read-only; it changes nothing) and fix any row whose `severity` is `blocking`:
   ```bash
   psql "$DATABASE_URL" -f packages/db/preflight/0003_staff_onboarding.sql      # then 0004, and so on, in order
   npm run db:migrate
   ```
   Migration 0002 on a database that already holds data: read `docs/SLICE-2-HANDOFF.md` first.
2. **API (Cloudflare Worker).** `npx wrangler hyperdrive create schoolpulse-db --connection-string=...`, paste the id into
   `apps/api/wrangler.toml`, set `ALLOWED_ORIGIN` to the web app's address, `npx wrangler secret put AUTH_SECRET` (at least 32 random
   bytes), then `npm run deploy -w @schoolpulse/api`. To switch on rate limiting, uncomment the `[[ratelimits]]` block at the end of
   `wrangler.toml` first.
3. **Web (Cloudflare Pages).** Root directory = repo root, build command `npm run build:web`, output directory `apps/web/dist`.
   Build variables: `VITE_API_URL` = the API's address (`https://...`, no path) and `NODE_VERSION` = `22.18` or newer.

### Check it after a deploy (five minutes)

```bash
curl -sI https://YOUR-APP/        | grep -iE "content-security|x-frame|referrer|strict-transport"
curl -sI https://YOUR-APP/accept  | grep -iE "content-security|x-frame"     # a deep link: the page that handles secrets
curl -sI https://YOUR-API/v1/me   | grep -iE "content-security|cache-control|referrer"      # 401 is expected: nobody is signed in
```

If `/accept` comes back without a `Content-Security-Policy`, stop: do not send real invitation links until that is fixed
(`docs/SECURITY.md`, section 2). Then open the app once with the browser's developer console visible and look for red
"Refused to ..." lines; sign in as a teacher; open a register; take it offline and save; go back online and watch it sync.

### Rolling back

- **Web / API:** redeploy the previous version from Cloudflare's deployment list. Both are stateless.
- **Undoing 0003 or 0004 by hand (only after a backup, and only if nothing needs them):** 0003 is `drop table staff_tokens;` and 0004 is
  `drop index audit_school_id_idx; drop index audit_school_actor_idx;`. Each must ALSO be followed by
  `delete from schema_migrations where name = '0003_staff_onboarding.sql';` (or `'0004_audit_viewer.sql'`), otherwise the migration runner believes
  it is still applied and will never apply it again.
- **Database:** no migration deletes a row. They add tables, columns and indexes; migration 0002 also relaxes one rule (class names
  are unique per school *and academic year* instead of per school) and fills in two new student columns from existing rows
  (details and the way back: `docs/SLICE-2-HANDOFF.md`). To undo a migration, restore the backup taken before it; the previous
  version of the application keeps working on the newer schema (tested for 0002). Dropping the new objects by hand would destroy
  data entered since, so it is a decision for after a backup, not a routine step.

## 5. When something is wrong

| Sign | Look at |
|---|---|
| Everyone gets "Something went wrong" | The Worker's logs (`npx wrangler tail`); then whether the database is reachable from Hyperdrive. |
| Sign-in answers "Too many attempts" | The rate limit is working; wait a minute. Many teachers on one Wi-Fi address share a counter. |
| A phone shows old data | It asks the server about every 30 seconds to 5 minutes and always does a full download after sending a register; opening the app or reconnecting checks at once. A full refresh also happens at least every 6 hours. |
| "Refused to ..." in the browser console | The security policy blocked something. Compare `VITE_API_URL` at build time with the API's real address. |
| A head is locked out | `reset-head` (section 3). |
