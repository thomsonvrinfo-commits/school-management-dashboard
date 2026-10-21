/**
 * Slowing down guessing. Every endpoint that takes a secret from someone who is not signed in (a password, a refresh
 * token, an invitation or reset link) is rate limited per caller address and per endpoint, so a script cannot try
 * thousands of passwords or links a minute.
 *
 * The limit itself is Cloudflare's Workers Rate Limiting binding (`AUTH_RATE_LIMIT` in wrangler.toml: how many requests per
 * 10 or 60 seconds). This module only decides WHICH requests count and what happens when the binding says "no". With no
 * binding configured (local development, the test suite) nothing is limited. If the binding itself fails, the request is
 * let through: a broken limiter must never stop a teacher from signing in.
 *
 * The key is the endpoint plus the caller's address, never an email address or a token: limiting by account would let a
 * stranger lock a teacher out of their own account by typing wrong passwords for them.
 */
import { HttpError } from "../errors.ts";
import type { RouteSpec } from "../routes.ts";

/** The shape of Cloudflare's rate-limit binding. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** Public endpoints are exactly the ones that take a secret from a stranger, so the route table decides what is limited. */
export function mustLimit(method: string, path: string, routes: readonly RouteSpec[]): boolean {
  return routes.some((r) => r.access === "public" && r.method === method && r.path === path);
}

/** One bucket per endpoint and address, so a busy refresh endpoint cannot use up the sign-in allowance. */
export const limitKey = (path: string, address: string | undefined | null): string => `${path}|${address?.trim() || "unknown"}`;

export const TOO_MANY = () => new HttpError(429, "too_many_requests", "Too many attempts. Wait a minute and try again.");

/** Throws a 429 when the limiter refuses this request. Everything else passes. */
export async function checkRate(
  limiter: RateLimiter | undefined,
  req: { method: string; path: string; address: string | undefined | null },
  routes: readonly RouteSpec[],
): Promise<void> {
  if (!limiter || !mustLimit(req.method, req.path, routes)) return;
  let allowed = true;
  try {
    allowed = (await limiter.limit({ key: limitKey(req.path, req.address) })).success;
  } catch (e) {
    console.error("Rate limiter unavailable; letting the request through", e);
  }
  if (!allowed) throw TOO_MANY();
}
