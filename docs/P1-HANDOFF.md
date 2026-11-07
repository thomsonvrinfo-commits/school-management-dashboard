# P1 handoff: a usable and proven foundation

Branch `p1/usable-foundation`, built on `slice-2/school-administration` (which is built on Slice 1). Nothing here has been pushed,
deployed, or run against any production database or hosting account. Everything was built and tested against throw-away local
PostgreSQL 16 databases and **assumes nothing about the state of production**. Migrations 0003 and 0004 have never been applied
anywhere except those throw-away databases.

Read with: `docs/ARCHITECTURE.md` (how it fits together), `docs/SECURITY.md`, `docs/GOVERNANCE.md`, `docs/RUNBOOK.md`.

## 1. Status in one paragraph

P1 is built and tested as far as this environment allows: **514 tests, 513 pass, 0 fail**, the one remaining test is a check that only
runs in the automatic pipeline (with `PSQL_TEST_CONN` set; the whole suite also passes sent to the database the way the production driver
sends it, `PSQL_TEST_EXTENDED=1`), plus **49 screen render checks** that pass. The type checker reports nothing except missing packages that cannot be installed here. What has **never
run**: the Hono wiring, the Vite build, the screens in a browser, the Dexie/IndexedDB glue, the production database driver, the
automatic checks on GitHub, the browser tests in `e2e/`, and anything on Cloudflare. They are written, and the first run on a real
machine is their real test (section 4). **Two of the three independent reviews have been done and their findings fixed or recorded; the third (documents, workflow, restore drill) has not** (section 5).

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

Independent review (reviewers who had not seen the code written, told to find defects and prove them by running things) was planned for
three areas. Usage limits stopped all three the first time; two have since reported.

**Staff onboarding and security: reviewed.** No way for one school to reach another's data was found. Findings and what happened:

| Finding | Status |
|---|---|
| A head could withdraw or replace another head's invitation (the operator's link) | **Fixed**, with a test: such a call is now refused (`head_invitation`). |
| "Not a common password" was a 24-entry list: `Password123!`, `qwerty123456`, `iloveyou1234` were accepted | **Improved**, with tests: common words are recognised under capitals, digits, a year, `!` and look-alike swaps, and keyboard and alphabet runs are refused. Still a short list, not a breach database. |
| Rate limiting counted each IPv6 address separately, so one machine could hop inside its /64 | **Fixed**, with tests: an IPv6 caller is counted per /64. |
| The local test server (`serve:web`) crashed on a malformed address such as `/%` | **Fixed** (answers 400). |
| Overclaiming wording: "every administrative change" is logged (the operator's commands write no row); the dry run "checks its input" (it only checks the options are present); the undo note for 0003 forgot the `schema_migrations` row | **Corrected** in `SECURITY.md`, the operator script and `RUNBOOK.md`. |
| A person who joins a second school with an existing account cannot sign in again from the web (no school picker) | **Open, recorded** in `SECURITY.md`. Needs a screen; to be done before any teacher works at two schools. |
| Invitations reveal whether an email already has an account; an unverified address can be taken first | **Open, recorded.** Needs email verification (P7). |
| A narrow race between a password reset and a second-school invitation finishing at the same instant | **Open, recorded.** The ordinary sequential case is tested. |
| Rate limiting is off until you switch it on | Already documented; unchanged. |

**Activity log and cheaper sync: reviewed.** No raw stored details or another school's rows can reach the Activity screen; the sync
fingerprint covers everything the phone shows and never leaks across users. Findings:

| Finding | Status |
|---|---|
| **Serious:** the Activity screen's first page (and "Show older") would have failed on the real database driver: the query sent a time-zone parameter nothing used, which PostgreSQL refuses. The test runner pastes values into the text, so no test could see it | **Fixed.** The test runner can now send statements the way the driver does (`PSQL_TEST_EXTENDED=1`) and the whole suite passes that way; a database-free test checks every parameter sent is used. Both fail on the old query (checked). |
| A school time zone written as `+02:00` was accepted and would put day boundaries hours out | **Fixed**: offsets are refused. |
| The class list order was not fully fixed (two classes can share a name), which could cause one needless full download | **Fixed** (tie-breaker added). |
| The sync engine could in theory recurse without end if a broken server answered "unchanged" to a full request | **Fixed** (it now stops and retries later). |
| Two narrow phone-side cases (discarding a failed register while a refresh is in flight; "keep theirs" when the server's row changed between the push and the refresh) could leave a stale copy until the next full refresh | **Open, reasoned only.** They sit in the part of the engine that needs a real browser to test (Dexie); they are repaired by the 6-hour full refresh at the latest. |

**Documents, GitHub workflow and restore drill: NOT yet reviewed.** That reviewer was stopped by a usage limit twice. Until it has run, treat
`docs/GOVERNANCE.md`, `.github/workflows/ci.yml` and `e2e/` as the builders' own work, unchecked by anyone else.

**Where some of these fixes came from.** When this section was written, a set of finished-looking changes was already sitting uncommitted in the
workspace (the test-runner mode, the activity-query fix, and the head-invitation guard with its test). They were not made by an
earlier step I can point to, and the reviewers had been told to change nothing, so their origin is uncertain. They were read in full,
proven against the old code, run in both test styles and then kept; the commit messages say so.

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
workflow run, fix whatever it finds, run the one review still outstanding (documents, workflow, restore drill), then deploy to a test environment you control.
