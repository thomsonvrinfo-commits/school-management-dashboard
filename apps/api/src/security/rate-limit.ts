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

/**
 * Who counts as "the same caller". An IPv4 address is one caller. An IPv6 customer is normally handed a whole /64 (2^64
 * addresses), so counting each address separately would let one machine hop to a fresh counter on every attempt: the
 * first four groups are the caller. An IPv4 address written the IPv6 way (::ffff:203.0.113.7) is that IPv4 address.
 */
export function callerOf(address: string | undefined | null): string {
  const a = (address ?? "").trim().toLowerCase();
  if (a === "") return "unknown";
  if (!a.includes(":")) return a;
  const mapped = /^(?:0{0,4}:){2,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1]!;
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return a;
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

/** One bucket per endpoint and caller, so a busy refresh endpoint cannot use up the sign-in allowance. */
export const limitKey = (path: string, address: string | undefined | null): string => `${path}|${callerOf(address)}`;

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
