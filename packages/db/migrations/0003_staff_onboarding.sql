-- SchoolPulse 0003: staff onboarding (P1).
-- Invitations for new staff and password-reset links issued by the head, both as single-use, expiring, hashed tokens.
--
-- ADDITIVE: one new table and its indexes. Nothing from 0001 or 0002 is changed, so a database running the earlier
-- migrations (and the API built for them) keeps working untouched. To undo: `drop table staff_tokens;` (it holds
-- only links that have not been used yet, and nothing else references it).
--
-- Run packages/db/preflight/0003_staff_onboarding.sql first; it is read-only.

create table staff_tokens (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools (id),
  -- 'invite': lets one person join this school. 'reset': lets one person of this school choose a new password.
  purpose     text not null check (purpose in ('invite', 'reset')),
  -- The address an invitation was sent to, or the account's address for a reset. Always lower-case.
  email       text not null check (length(email) between 3 and 254 and email = lower(email)),
  -- A name the head typed to help the person recognise the invitation (optional; the person confirms their own name).
  name        text check (name is null or length(name) between 1 and 200),
  role        text check (role in ('head', 'teacher')),
  user_id     uuid references users (id),
  -- SHA-256 of the token. The token itself is shown once, to the head, and never stored.
  token_hash  text not null unique check (length(token_hash) between 20 and 100),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  unique (school_id, id),
  constraint staff_tokens_shape check (
       (purpose = 'invite' and role is not null and user_id is null)
    or (purpose = 'reset'  and role is null     and user_id is not null)
  ),
  constraint staff_tokens_one_ending check (not (used_at is not null and revoked_at is not null))
);

-- At most one link that is still waiting per person per school. The service retires the old one when it issues a new
-- one; this index is the backstop if two heads issue at the same moment.
create unique index staff_tokens_one_open_invite
  on staff_tokens (school_id, email) where purpose = 'invite' and used_at is null and revoked_at is null;
create unique index staff_tokens_one_open_reset
  on staff_tokens (school_id, user_id) where purpose = 'reset' and used_at is null and revoked_at is null;
create index staff_tokens_school_idx on staff_tokens (school_id, created_at desc);
