# SchoolPulse security: what is in place, what still needs switching on, what is not done

This file separates three things on purpose, because a school's data deserves an honest account:

- **In the code and tested** here (with the level of evidence stated).
- **Written but not switched on** (needs a decision or a setting on the hosting account).
- **Not done** (and why, and when it is planned).

Evidence levels used in this repository: **unit** (pure logic under `node --test`), **integration** (real PostgreSQL),
**render** (real React markup, no browser), **not verified here** (needs a real browser, the real hosting, or the internet).

## 1. In place

| Area | What it does | Evidence |
|---|---|---|
| Passwords | PBKDF2-SHA256, 100,000 rounds, random salt, constant-time comparison. Unknown and switched-off accounts take as long as real ones to refuse. | integration (`auth.test.ts`, `crypto.test.ts`) |
| Password rules | At least 10 characters, at most 128, at least 5 different characters, not a common password (a list of the most-used words such as "password", "qwerty" or "iloveyou" is checked underneath capitals, digits, a trailing year, "!" and look-alike swaps like "p@ssw0rd", and keyboard or alphabet runs are refused; it is a short list, not a full breach database), not built from the person's own name or email. Applied when someone sets a password through an invitation or a reset link, on the phone and again on the server (same code). Spaces allowed: a phrase of a few words is the advice given on screen. | unit (`packages/domain/test/staff.test.ts`, `apps/web/test/staff-forms.test.ts`), integration (`staff.test.ts`) |
| Sessions | 15-minute access token; 60-day refresh token that changes every use and is stored only as a SHA-256; one session per device. Role and school are read from the database on every request, so switching someone off or revoking a device works at once. | integration |
| Switching access off | Ends every session of that person at that school in the same transaction, blocks sign-in, and withdraws any waiting reset link. | integration (`staff.test.ts`) |
| Invitation and reset links | 256 random bits, stored only as a SHA-256, shown once to the head, single-use (claimed atomically: six simultaneous attempts, exactly one wins), expire (7 days / 24 hours), revocable, replaced when re-issued. Delivered by the head by hand (WhatsApp, text, in person): nothing is emailed. The secret travels in the part of the address after `#`, which a browser never sends to a server, and the page removes it from the address bar. | integration, unit (`link-token.ts`), render |
| Who may manage whom | A head manages teachers only. Head accounts are created and recovered by the platform operator's command line, so one head cannot lock out or take over another. A reset is refused for an account that also works at another school (a password belongs to the person, not the school). | unit, integration |
| Tenant isolation | `school_id` on every school table, composite foreign keys, school taken from the session (or from the link on the three public endpoints), strict request bodies, foreign ids answer 404. | integration (cross-school tests in every suite) |
| Permissions | One deny-by-default function; the route table lists every route and its policy; a test fails if a public route appears without a deliberate edit; the role gate runs before a request body is read. | unit, integration |
| Activity log | Every administrative change made through the app is written in the same transaction as the change (the platform operator's terminal commands write no activity row; they print what they did). The head's Activity screen shows a plain-language summary and never the stored details (no admission numbers, ids or per-child marks); a test checks every action the API writes is described. | unit, integration |
| API response headers | `nosniff`, `no-store`, a policy that forbids scripts and framing, no Referer. | unit |
| Web security headers | `dist/_headers` is generated at build time from the API address: scripts only from the app's own origin (no inline, no `eval`), connections only to the app and the API, never framed, no Referer, no camera/microphone/location, HSTS (180 days, no preload). Fingerprinted files cached a year; the page and service worker revalidated every visit. | unit (7 tests). **Not verified in a browser** |
| Rate limiting (code) | Every public endpoint is limited per endpoint and caller, when the binding below is configured. A caller is an IPv4 address, or the first half (/64) of an IPv6 address, because one machine usually owns the whole /64. The address comes from Cloudflare's `cf-connecting-ip` header, which is only trustworthy behind Cloudflare; if it were ever missing, every caller would share one counter. A broken limiter lets people in; a refusal is a 429 with `Retry-After`. | unit (8 tests). The Cloudflare binding itself is **not verified here** |

## 2. Written but not switched on (needs you, on the hosting account)

Nothing below has been done to any live system. Each is a setting you apply when you decide to deploy.

1. **Rate-limit binding.** Uncomment the `[[ratelimits]]` block at the end of `apps/api/wrangler.toml` (30 requests a minute per
   endpoint per address, per Cloudflare location). Why 30: many teachers share one school Wi-Fi address and sign in near the
   same time (start of term), so a very small number would lock a whole school out; 30 a minute still turns an unlimited guessing
   script into a slow one. Counters are approximate and per location, so this slows guessing, it does not stop it. The
   password rules above are what make slow guessing hopeless; the limit is the second layer.
2. **Web build setting.** Set `VITE_API_URL` (the API's address, `https://...`, no path) in the Pages build settings. The build
   writes it into the security policy and **stops with an error** if it is not a plain https address.
3. **API setting.** `ALLOWED_ORIGIN` must be exactly the web app's address (it is the only origin the API answers to from a browser).
   `AUTH_SECRET` must be a fresh random value of at least 32 bytes, set as a secret, never committed.
4. **Node version for the web build.** The build step that writes the headers uses Node's built-in TypeScript support: set the
   Pages build variable `NODE_VERSION` to `22.18` or newer.

### Check it after a deploy (five minutes, from any computer)

```
curl -sI https://YOUR-APP/            | grep -iE "content-security|x-frame|referrer|strict-transport"
curl -sI https://YOUR-APP/accept      | grep -iE "content-security|x-frame"      # a deep link: the page that handles secrets
curl -sI https://YOUR-API/v1/me       | grep -iE "content-security|cache-control|referrer"
```

The second line matters most: Cloudflare's documentation does not say whether `_headers` rules apply to pages served by the
single-page-app rewrite (`/* /index.html 200`). If `/accept` comes back **without** a `Content-Security-Policy`, say so: the fix is
to serve the rewrite differently, and it should be done before real invitation links are sent.

Then open the app once with the browser's developer console visible and look for red "Refused to ..." lines (the policy blocking
something the app needs). The end-to-end test (`docs/RUNBOOK.md`) does the same automatically.

## 3. Not done, and why

| Gap | Why it is not done now | Plan |
|---|---|---|
| Per-account lock-out after wrong passwords | It would let a stranger lock a teacher out of their own account by typing wrong passwords for them. Address-based limiting plus long passwords is the safer trade for a school. | Revisit with alerting (P8), not before. |
| Refresh-token reuse detection (a stolen, already-used token ends the whole sign-in) | Needs a token "family" column; a migration for a risk that is small while sessions are bound to a device id. | P2 backlog. |
| Multi-factor sign-in | No email or phone channel exists yet; links are hand-delivered. | When a communication channel exists (P7). |
| Email verification | Invitations go to an address the head typed and the person proves they hold the link, not the mailbox. The head vouches for the person. | Acceptable for the pilot; reconsider with P7. |
| Signing in after joining a second school | A person who already has an account and accepts an invitation from another school ends up with two memberships; signing in then needs a school choice, and the web login form has no school picker. They are signed in once (when they accept) and cannot sign in again from the web until a picker is built. Found by the independent review. | Build the picker (or refuse such invitations) before any teacher works at two schools. |
| Invitations reveal whether an email already has an account | A head can invite any address and read `accountExists` from the link's preview; the accept page is also a second place to guess that account's password (it has its own rate-limit counter). Closing it properly needs email verification. | With the first communication channel (P7); until then heads are trusted not to probe. |
| An unverified address can be taken first | A head can accept their own invitation to an address nobody has used and set its password; that person's real school can then not invite them. Same root cause as above. | With P7. |
| A narrow race on the "one password belongs to one person" rule | A password-reset and an invitation at a second school finishing at the very same moment are not serialised. The sequential case is tested and safe. | Revisit if a person ever works at two schools. |
| A screen for "sign out my other devices" | The API revokes sessions; there is no button. | P1 follow-up if wanted. |
| PostgreSQL row-level security | Application-level isolation is tested everywhere; RLS is the second lock. It needs a database role per request, which Hyperdrive makes non-trivial. Design in `docs/GOVERNANCE.md`. | Before any data beyond attendance is added (P4). |
| `access_log` (who looked at which child's record) | Nothing reads sensitive child records yet, so there is nothing to log. An empty table adds risk and no value. | Created together with the first screen that shows a development record (P5). |
| PBKDF2 above 100,000 rounds | Cloudflare Workers cap PBKDF2 at 100,000. | Compensated by the length rules; revisit if the runtime allows more. |

## 4. How to run the checks that exist

```
npm test                                  # 440+ tests; the database ones need PSQL_TEST_CONN (see docs/RUNBOOK.md)
npm run check:render                      # real-React markup checks for every screen component
npm run check:imports                     # every import resolves, every package is declared
npm run build:web && npm run serve:web    # the built app behind the production security headers, on http://localhost:4173
```
