import type { LoginRequest, MeResponse, RefreshRequest, TokenResponse } from "@schoolpulse/contracts";
import type { ActiveContext } from "@schoolpulse/db";
import type { Principal } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { REFRESH_TOKEN_DAYS, hashRefreshToken, newRefreshToken, signAccessToken, verifyAccessToken } from "../auth/token.ts";

export interface AuthContext {
  principal: Principal;
  ctx: ActiveContext;
}

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
const invalidSession = () => new HttpError(401, "invalid_session", "Please sign in again.");

// Verified against when the email is unknown, so "no such user" and "wrong password" take the same time.
let dummyHash: Promise<string> | undefined;

export function meOf(ctx: ActiveContext): MeResponse {
  return { user: ctx.user, school: ctx.school, role: ctx.role };
}

async function issueTokens(deps: Deps, ctx: ActiveContext, refreshToken: string): Promise<TokenResponse> {
  const { token, expiresAt } = await signAccessToken(deps.authSecret, { sub: ctx.user.id, sid: ctx.sessionId }, deps.now());
  return { accessToken: token, accessTokenExpiresAt: expiresAt, refreshToken, me: meOf(ctx) };
}

const refreshExpiry = (now: Date) => new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000).toISOString();

export async function login(deps: Deps, req: LoginRequest): Promise<TokenResponse> {
  const store = deps.db.store;
  const user = await store.findUserByEmail(req.email);
  if (!user || !user.active) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(req.password, await dummyHash);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(req.password, user.passwordHash))) throw invalidCredentials();

  const memberships = await store.listMemberships(user.id);
  if (memberships.length === 0) throw new HttpError(403, "no_active_membership", "This account is not active at any school.");
  let membership = memberships[0]!;
  if (req.schoolId) {
    const chosen = memberships.find((m) => m.schoolId === req.schoolId);
    if (!chosen) throw new HttpError(403, "no_active_membership", "This account is not active at that school.");
    membership = chosen;
  } else if (memberships.length > 1) {
    throw new HttpError(409, "school_selection_required", "This account belongs to more than one school; choose one.");
  }

  const sessionId = deps.newId();
  const refreshToken = newRefreshToken();
  await store.createSession({
    id: sessionId, userId: user.id, schoolId: membership.schoolId, membershipId: membership.id,
    deviceId: req.deviceId, refreshHash: await hashRefreshToken(refreshToken), expiresAt: refreshExpiry(deps.now()),
  });
  const ctx = await store.getActiveContext(sessionId, deps.now().toISOString());
  if (!ctx) throw invalidSession();
  return issueTokens(deps, ctx, refreshToken);
}

/** Exchange a refresh token for a new access token and a NEW refresh token (the old one stops working). */
export async function refresh(deps: Deps, req: RefreshRequest): Promise<TokenResponse> {
  const store = deps.db.store;
  const session = await store.findSessionByRefreshHash(await hashRefreshToken(req.refreshToken));
  if (!session || session.revoked || session.deviceId !== req.deviceId || new Date(session.expiresAt) <= deps.now()) {
    throw invalidSession();
  }
  const next = newRefreshToken();
  await store.rotateSession(session.id, await hashRefreshToken(next), refreshExpiry(deps.now()));
  const ctx = await store.getActiveContext(session.id, deps.now().toISOString());
  if (!ctx) throw invalidSession();
  return issueTokens(deps, ctx, next);
}

export async function logout(deps: Deps, refreshToken: string): Promise<void> {
  const session = await deps.db.store.findSessionByRefreshHash(await hashRefreshToken(refreshToken));
  if (session) await deps.db.store.revokeSession(session.id);
}

/**
 * Turns an `Authorization: Bearer ...` header into who is calling. The role and school come from the database
 * on every request (not from the token), so removing someone or revoking a device takes effect immediately.
 */
export async function authenticate(deps: Deps, header: string | undefined | null): Promise<AuthContext> {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) throw new HttpError(401, "unauthenticated", "Sign in required.");
  const claims = await verifyAccessToken(deps.authSecret, m[1]!, deps.now());
  if (!claims) throw new HttpError(401, "unauthenticated", "Sign in required.");
  const ctx = await deps.db.store.getActiveContext(claims.sid, deps.now().toISOString());
  if (!ctx || ctx.user.id !== claims.sub) throw new HttpError(401, "unauthenticated", "Sign in required.");
  return { ctx, principal: { userId: ctx.user.id, schoolId: ctx.school.id, role: ctx.role } };
}
