# SchoolPulse governance notes

Decisions and positions about the data SchoolPulse holds: what it is, who may see it, how it is kept safe, how it is restored, and
how long it is kept. Written by the people building the software, **not by a lawyer**. Every item says whether it is
**built and tested**, **designed only**, or **needs a decision from the school or a legal adviser**. Nothing here has been put to a
real school yet.

Related: `docs/SECURITY.md` (how it is defended), `docs/RUNBOOK.md` (how it is operated), `docs/ARCHITECTURE.md` (how it is built).

## 1. What the system holds today

Everything is about children and the staff who teach them, so all of it is treated as sensitive.

| Data | Where | Notes |
|---|---|---|
| Student: first and last name, other names, admission number, date of birth, gender, status (enrolled, withdrawn, transferred, graduated), enrolment date | `students` | Date of birth and gender are optional. They are **never sent to a teacher's phone**; the phone gets name, admission number and class only (tested). |
| Which class a child is in, and when | `enrollments` | Effective-dated: history is kept, never overwritten. |
| Daily attendance: present, late or absent, who recorded it, from which device | `attendance_records` | Teachers see the classes they teach; the head sees all. |
| Staff: name, email, role, a salted password hash (PBKDF2-SHA256) | `users`, `memberships` | A password is never stored or logged. |
| Sign-ins: device id, hash of the refresh token, expiry | `sessions` | Refresh tokens last 60 days; access tokens 15 minutes. |
| Invitation and reset links: hash of the link, purpose, expiry, used/revoked | `staff_tokens` | The link itself is never stored. Invitations last 7 days, resets 24 hours, each works once. |
| Activity log: who did what, when, with short details such as a class name | `audit_log` | Only the head can read it, in plain words. Append-only in the code; there is no delete or edit path. |
| Record of offline operations already applied | `processed_operations` | Lets a phone retry safely. |

On a teacher's phone, in the browser's own storage (IndexedDB): the teacher's classes, those children's names and admission numbers,
and the last 14 days of their attendance. Signing out, or the server refusing the session, wipes it (`wipeLocalData`). A phone that
is simply lost keeps its copy until then; see 2.

Not held yet: marks, comments, behaviour or welfare notes, health information, contact details of parents, photos, messages. Each
of these changes the picture. **None may be added without revisiting this document first** (section 7).

## 2. Who can see what

Two roles. The permission table is one pure function (`packages/domain/src/authz.ts`), deny by default, and every request is
checked against it on the server, never in the screen.

| | Head | Teacher |
|---|---|---|
| Their own school's classes, students, timetable, staff list, activity log | all | no |
| A class's roster and register | all classes | only classes they are assigned to |
| Attendance summary for the school | yes | no |
| Another school's anything | no | no |

Built and tested: the school is always taken from the signed-in session (or from an invitation link), never from a request body; a
foreign or malformed id answers "not found"; two schools run side by side in the tests and the second never sees the first.

**Lost or stolen phone.** The copy on the phone is readable by anyone who can open the browser profile. Mitigations that exist: the
head can deactivate the teacher, which ends their sessions, so no further data is fetched and the next sync is refused; the
copy holds names and attendance only (no dates of birth, no notes). What does not exist: remote wipe, and a PIN or lock on the app
itself (the phone's own lock screen is the control). **Recommendation for schools:** phones used for registers must have a screen lock.

**Who looked at what.** Changes are logged and visible to the head. *Reading* a child's record is not logged, because nothing
reads sensitive records yet. A read log (`access_log`) is created together with the first screen that shows a development
record (P5), not before.

## 3. Principles for everything built from here

These are commitments for the later phases, taken from the original brief. They are the test a feature has to pass before it is built.

1. **Collect only what a teaching or care purpose needs.** Each new field is justified in the phase that adds it.
2. **Never rank or label children.** No league tables of pupils, no "at risk" badges as a verdict. Intelligent features describe what
   was recorded, show the evidence, and say how uncertain it is.
3. **Never make a high-impact decision.** Nothing automatic changes a child's class, marks, discipline or support. A person decides.
4. **Show the source.** Every figure and every sentence the system produces points to the records behind it, and says when records are missing
   (a day without a register is *unknown*, not *present*).
5. **No AI on identifiable child data until the owner agrees in writing** to the evaluation set, the provider terms, what is sent, and
   what is kept (P8). Until then no child data leaves the school's own database and the app's own servers.
6. **Respect the permission model.** An answer may only use records the person asking could open themselves.

## 4. Row-level security: the second lock (designed, not built)

Today the isolation between schools is enforced by the application: every query carries `school_id`, composite foreign keys stop a row
pointing into another school, and tests prove it. If one query forgot the filter, the database would not stop it. Row-level security
(RLS) makes PostgreSQL itself refuse.

**Design**

- The application connects as a role that is **not** the table owner and has no `BYPASSRLS` or superuser rights. Migrations run as a
  separate owner role. Tables get `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- Every request runs inside a transaction that begins with `set_config('app.school_id', <the session's school>, true)` (transaction-local).
  A policy on each table: `school_id = nullif(current_setting('app.school_id', true), '')::uuid`. Without the setting, the policy
  matches nothing: it fails closed.
- Transaction-local settings are the point: they stay correct behind a connection pooler such as Hyperdrive, which hands the same
  database connection to different requests. A session-level `SET` would leak from one request to the next and must never be used.
- The store already has a `transaction` wrapper, so the change is mostly one function that every request goes through.
- Pre-login endpoints (sign in, accept an invitation, reset a password) have no school yet. They run through narrow
  `SECURITY DEFINER` functions or a separate role limited to `users`, `memberships`, `sessions` and `staff_tokens`, so the broad role never
  needs to bypass anything.

**Evidence needed before it is switched on**

1. A test that connects as the restricted role and shows that a query *with no school filter at all* returns only the current school's rows, and no
   rows when no school is set.
2. The whole existing suite passing through the restricted role (the tests already run against a real PostgreSQL).
3. A check, on the real hosting, that the setting does not leak between requests through the pooler. **This cannot be checked from
   the environment the code was written in** and is the main reason RLS has not been switched on blind.
4. Migration safety: the pre-flight lists tables lacking a `school_id`, and the role change is applied in a separate, reversible step.

**When:** before any data beyond attendance is added (P4: assessment). Until then the application-level isolation is the control.

## 5. Backup and restore

A backup nobody has restored is a hope. This section says what exists and what is still to be done.

**Built and tested (integration, real PostgreSQL 16):** `packages/db/test/backup-restore.test.ts` takes a `pg_dump` of a database that holds
data from every migration, restores it into an empty database, and shows the copy is the same database: every table has exactly the same rows
(compared by a checksum per table), every constraint and index is back (including the "one class at a time" exclusion rule and the not-yet-validated
legacy constraints), the migration runner finds nothing left to do, activity-log numbering carries on without collisions, and the "one class per day" rule
still refuses a double placement in the copy. Damaging the copy in four different ways makes the test fail. In the automatic checks the
test fails rather than skips if `pg_dump` is missing.

**What that does not prove:** that the hosting provider's own backups work. The provider, plan, retention window and restore procedure
are not chosen yet, so that drill cannot be done.

**Recommended routine (for the owner to accept or change)**

| What | Proposal |
|---|---|
| Provider backups | Switch on whatever point-in-time restore the database host offers and **read its retention in the host's own console before the pilot**; do not assume a number. |
| Your own copy | A daily `pg_dump --format=custom --no-owner` of the production database, kept somewhere that is *not* the database host. |
| Encryption | The dump holds children's names. Encrypt it before it leaves the machine (for example with `age` or `gpg`), and keep the key somewhere other than next to the backups. |
| Retention | 30 daily copies and 12 monthly copies. A school decides if that is too long (section 6). |
| Drill | Restore the latest copy into an empty database, run `npm run db:migrate` (must say "Database is up to date.") and open the app against it, once before the pilot and then every term. Write down the date and how long it took. |
| Before every migration | Take a fresh dump first (`docs/RUNBOOK.md`, section 4). |

**Restoring**

```bash
createdb schoolpulse_restore                                   # an EMPTY database, never the live one
pg_restore --no-owner --exit-on-error --dbname=schoolpulse_restore backup.dump
DATABASE_URL=postgres://.../schoolpulse_restore npm run db:migrate    # expect "Database is up to date."
```

Then point a test copy of the API at it and sign in. Only after that decide whether to switch the live system over.

**Decisions for the owner:** how much recent data the school can afford to lose (hours? a day?) and how long it can be without the system. These
set how often to back up and which provider plan is worth paying for.

## 6. Keeping and deleting data

What the code does today: nothing deletes a student. A child who leaves is marked withdrawn, transferred or graduated, and their history stays.
The head can delete an academic year or a term only when nothing depends on it, and cannot move or end a placement once registers exist from that day on
(the rules refuse). A teacher can be taken off a class at any time. The activity log and attendance history are never deleted by the application.

What is **not** built: an "erase this child" function, a retention clock, a way to export one child's data. Each is a design decision, not just code,
because attendance and later assessment records may have to be kept by the school for a period, and a child may have a right to see, correct or have
their data removed.

**Proposal (needs the school and a legal adviser to confirm):**

- Keep a child's records for the period the school's own rules or the education ministry require; keep nothing "just in case".
- After that period, **anonymise rather than delete**: replace names and admission number with a neutral label and remove date of birth and gender,
  so class and school statistics stay correct but no child can be identified. Keep a note in the activity log of when, by whom and why.
- A request from a parent or guardian to see or correct their child's record goes through the head. Until an export exists, the operator can produce
  the child's rows with a few reviewed queries (written when the first request arrives, not guessed in advance).
- Staff who leave are deactivated, not deleted, so the activity log still says who did what.

**Still to be built when decided:** an operator command for anonymising a student, a retention report, and a test that proves an anonymised child
cannot be found in the replica, the roster, the register or the activity log.

## 7. Legal and regulatory position

**Not decided.** The country of the first schools is an open question for the owner. If it is Zimbabwe, the Cyber and Data Protection Act
(Chapter 12:07) and its licensing regulations are likely to apply to a service that stores children's data, and may require registration with the regulator,
a named data-protection officer, notice to parents, and rules on keeping data inside or outside the country. That reading comes from desk research, not legal
advice: **a Zimbabwean practitioner must confirm it before real children's records are entered.** Where the data is physically held matters too: the
database host and Cloudflare's regions are choices that have not been made.

**Do before a pilot with real data (owner or school, with advice):**

1. Confirm which law applies and what registration or notice it requires.
2. Decide who is the "controller" (probably each school) and who is the "processor" (the operator running the service), and put that in a written agreement.
3. Write a plain-language notice for parents and guardians: what is kept, why, who sees it, how to ask about it.
4. Choose the database region and provider with item 1 in mind.
5. Agree who is told, and how quickly, if data is lost or exposed (section 8).

## 8. If something goes wrong

Short version; the operator steps are in `docs/RUNBOOK.md`, section 5.

- **A phone is lost:** the head deactivates the teacher on the Staff screen (ends the sessions). Tell the teacher to change any password they reuse elsewhere.
- **A password is exposed:** the head issues a reset link (all that person's sessions end when it is used).
- **A link was sent to the wrong person:** the head withdraws the invitation or issues a new reset; an old link stops working.
- **The signing secret (`AUTH_SECRET`) may be exposed:** replacing it signs everyone out of the 15-minute access tokens at once; then end every sign-in in the database
  (`update sessions set revoked_at = now() where revoked_at is null;`) so refresh tokens stop working too. Every user then signs in again.
- **Data exposed or lost:** note when it was found, what it contained and whose it is; stop the cause; tell the head and the school's
  controller **immediately**, because the law (section 7) may set a deadline for telling the regulator and families. The activity log shows what was changed;
  it does not show what was only read.

## 9. Open decisions

| # | Decision | Needed before |
|---|---|---|
| 1 | Which country's law applies, and what registration or notice it requires (section 7) | Any real children's data |
| 2 | Database provider, region and backup plan (section 5) | Any real children's data |
| 3 | How much data loss and downtime the school can tolerate (section 5) | Choosing the backup plan |
| 4 | Retention period and anonymise-or-delete policy (section 6) | A child's record is a year old; at the latest |
| 5 | Who answers a parent's request to see or correct a record | The first request |
| 6 | Whether to switch on RLS before or at P4 (section 4) | Any data beyond attendance |
| 7 | Written agreement on AI use: provider, data sent, evaluation (principle 5) | P8 |
