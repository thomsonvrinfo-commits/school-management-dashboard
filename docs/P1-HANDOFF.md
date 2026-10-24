# P1 handoff: a usable and proven foundation

Branch `p1/usable-foundation`, built on `slice-2/school-administration` (which is built on Slice 1). Nothing here has been pushed,
deployed, or run against any production database or hosting account. Everything was built and tested against throw-away local
PostgreSQL 16 databases and **assumes nothing about the state of production**. Migrations 0003 and 0004 have never been applied
anywhere except those throw-away databases.

Read with: `docs/ARCHITECTURE.md` (how it fits together), `docs/SECURITY.md`, `docs/GOVERNANCE.md`, `docs/RUNBOOK.md`.

## 1. Status in one paragraph

P1 is built and tested as far as this environment allows: **499 tests, 498 pass, 0 fail**, the one remaining test is a check that only
runs in the automatic pipeline (with `PSQL_TEST_CONN` set; without a database 236 pass and 263 are skipped, none fail), plus **49 screen
render checks** that pass. The type checker reports nothing except missing packages that cannot be installed here. What has **never
run**: the Hono wiring, the Vite build, the screens in a browser, the Dexie/IndexedDB glue, the production database driver, the
automatic checks on GitHub, the browser tests in `e2e/`, and anything on Cloudflare. They are written, and the first run on a real
machine is their real test (section 4). **The independent review of this stage did not happen** (section 5).

## 2. What the product did before and what it does now

| | Before P1 | After P1 |
|---|---|---|
| Getting staff in | Accounts came from the seed or hand-written SQL. | The head invites a teacher (or issues a password-reset link) from a Staff screen and hands the link over by WhatsApp, text or in person. The person opens it, chooses a name and password, and is signed in. The head can switch a teacher's access off and on. Head accounts are created and recovered by the platform operator's command line. |
| Passwords | Any password the seed set. | At least 10 characters, not a common password, not built from the person's name or email; checked on the phone and again on the server with the same code. |
| Seeing what changed | Nothing. | The head's Activity screen: who changed what, in plain words, newest first, a page at a time, filtered by kind, person and day. It never shows ids, admission numbers or marks. |
| Browser and API protection | None beyond the framework defaults. | A strict content-security policy and other headers generated at build time; protective headers on the API; optional rate limiting on every endpoint that takes a secret from a stranger. |
| Phone data use | Re-downloaded the whole 14-day copy every 30 seconds, forever. | Asks "has anything changed?" and gets about 100 bytes back; polls slower when nothing happens, slowest when the app is in the background, not at all when offline. |
| Checking the work | A person ran the tests. | A GitHub workflow (written, not yet run), a real-browser test scaffold (written, not yet run), a runbook, a restore drill that runs now. |
| Written down | Architecture notes and the Slice 2 handoff. | Plus security, governance (what is held, who sees it, backups, retention, the legal position) and the runbook. |

## 3. What was built

| Item | Commits | Evidence |
|---|---|---|
| **P1.4 Staff onboarding.** Migration 0003 (`staff_tokens`), rules in `packages/domain/src/staff.ts`, store, services, 9 routes, operator commands, screens (staff list, invitation and reset links, join and reset pages). | `f215542` `0f0dd0c` `93506f2` `b2cdfa0` | unit, integration (real PostgreSQL, including six simultaneous attempts on one link), render. Every mutation of the staff rules that was tried is caught by a test. |
| **P1.5 Activity log.** Migration 0004 (two indexes), deny-by-default describer, cursor-paged head-only endpoint, screen. | `d958cb0` `04aef84` `5f1606a` | unit, integration, render. The raw response shape is checked strictly. |
| **P1.3 Security.** Headers and policy from the API address, API headers, optional rate limiter, `docs/SECURITY.md`. | `0ff62bb` | unit. The browser behaviour and the Cloudflare binding are **not verified here**. |
| **P1.6 Cheaper sync.** Version fingerprint, `?since=`, adaptive polling rules, engine changes, stable ordering in replica queries. | `9b42380` | 36 tests (unit and real PostgreSQL); all 26 deliberate breakages of the new logic are caught. The engine glue against a real IndexedDB is **not verified here**. |
| **P1.1 / P1.2 Checks and runbook.** `.github/workflows/ci.yml`, `e2e/`, `docs/RUNBOOK.md`, `scripts/check-imports.ts`. | `b5506fb` | Written, **never run**. |
| **P1.7 Governance, restore drill, architecture, this handoff.** | `8484d56` and the commit that adds this file | The restore drill is integration-level and fails when the copy is damaged in any of four ways. The documents are the builders' own, not a lawyer's. |

New and changed routes, all listed in `apps/api/src/routes.ts` (the single table of routes and who may call them):
`GET /v1/staff`, `POST /v1/staff/invitations`, `DELETE /v1/staff/invitations/:id`, `POST /v1/staff/:membershipId/{deactivate,reactivate,reset-link}`
(head only); `POST /v1/invitations/{preview,accept}` and `POST /v1/password-reset/complete` (public, take a link);
`GET /v1/audit` (head only); `GET /v1/sync/bootstrap` now accepts `?since=`.

Existing source files from earlier slices that P1 modified (all backward compatible; the Slice 1 and 2 tests still pass, apart from a few
that had to learn about the new routes and the new `version` field in the sync answer): `apps/api/src/{app,deps,index,routes}.ts`, `apps/api/src/auth/token.ts`,
`apps/api/src/services/{auth,sync}.ts`, `apps/api/src/school-admin/{common,handlers,http}.ts`, `apps/api/wrangler.toml`,
`packages/db/src/{admin-store,postgres-admin-store,postgres-store,index}.ts` (store additions; two `order by` tie-breakers),
`packages/contracts/src/{index,primitives}.ts`, `packages/domain/src/{authz,index}.ts`, `packages/sync/src/index.ts`,
`apps/web/src/{App.tsx,components/shell.tsx,components/ui.tsx,lib/{admin-api,api,auth,sync-engine}.ts}`, `apps/web/package.json`,
`package.json`, `scripts/check-imports.ts`.

## 4. Evidence levels, and what is still unproven

| Level | What it covers | Where it ran |
|---|---|---|
| unit | Rules and pure logic: passwords, link states, activity wording, version, polling schedule, form checks, headers file | here |
| integration | API handlers, services and store against a real PostgreSQL 16, migrations and their pre-flight checks, the restore drill | here |
| render | The screens as markup, with accessibility checks, no browser | here (bun) |
| browser | `e2e/smoke.spec.ts`: policy blocks nothing the app needs, teacher sign-in, "unchanged" answered to a phone holding the current copy | **never run** |
| not verified here | Hono adapter (CORS, header and rate-limit middleware, 429 answers), Vite build and the headers file it writes, the production database driver through Hyperdrive, Dexie/IndexedDB behaviour of the engine, the screens' router and network glue, GitHub workflow, Cloudflare Pages `_headers` on deep links such as `/accept`, Cloudflare's rate-limit binding, a hosting provider's backups | needs GitHub, a browser or the real hosting |

The first thing to do on a machine with internet is `npm install`, then the checks in `docs/RUNBOOK.md` (section 1), then push the branch so
the workflow runs. Anything that fails there is a real finding, not a surprise: the list above is exactly where to look.

## 5. Review status

Independent review (people or agents who have not seen the code written) was planned for three areas: staff onboarding and
security; the activity log and cheaper sync; and the documents, workflow and restore drill against the code. All three reviewers were
started and **all three were stopped by a usage limit before reporting anything**; a retry stopped the same way. **No independent review
result exists for P1.** The only checking this stage has had is the builders' own: the tests, deliberate breakage of the logic to see the
tests catch it (done for staff onboarding, the activity log, cheaper sync and the restore drill), reading, and a type check.
Treat P1 as **unreviewed** until the three reviews are run. Slice 2 did get an independent review.

## 6. Safe choices made on your behalf (all easy to change)

1. **Invitation and reset links are handed over by the head by hand** (WhatsApp, text, in person). Nothing is emailed or texted by the system,
   so no message provider, phone numbers or sender identity were needed.
2. **No new roles.** Head and teacher only. A head manages teachers; only the operator's command line creates or recovers a head.
3. **Everything was tested locally.** No cloud test environment, no deployment, no production data or migration, nothing pushed.
4. **Rate limiting is written but off**: the Cloudflare block in `wrangler.toml` is commented out until you switch it on.
5. **No row-level security yet**; designed and written down (`docs/GOVERNANCE.md`, section 4), to be done before any data beyond attendance.
6. **No child data is sent anywhere outside the school's own database and the app's own servers**, and none will be until you agree in writing (principle 5 in `docs/GOVERNANCE.md`).

## 7. Decisions only you can make

`docs/GOVERNANCE.md`, section 9, has the full list. The ones that block real use: **which country's law applies** (for example Zimbabwe's
data-protection act: a local practitioner must confirm what is required before real children's records are entered), **where the database
is hosted and how it is backed up**, **how much lost data or downtime a school can tolerate**, and the pilot school and its curriculum.

## 8. What comes next

P2 (teaching structure: subjects, who teaches what and when, and honest attendance: a day nobody took a register is *unknown*, not
*present*), then P3 attendance intelligence, P4 assessment, P5 development record and support, P6 school conditions, P7 communication,
P8 AI-assisted intelligence last, on top of evidence that already exists. Before P2 starts, the sensible order is: push the branch and let the
workflow run, fix whatever it finds, run the three reviews, then deploy to a test environment you control.
