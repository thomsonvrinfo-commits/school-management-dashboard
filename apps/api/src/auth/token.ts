/** Short-lived access tokens (HS256 JWT) and opaque refresh tokens. */
import { constantTimeEqual, fromB64Url, toB64Url, utf8 } from "../encoding.ts";

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 60;

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  iat: number;
  exp: number;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signAccessToken(secret: string, claims: Omit<AccessClaims, "iat" | "exp">, now: Date): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ACCESS_TOKEN_SECONDS;
  const header = toB64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = toB64Url(utf8(JSON.stringify({ ...claims, iat, exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8(`${header}.${body}`));
  return { token: `${header}.${body}.${toB64Url(new Uint8Array(sig))}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Returns the claims, or null for anything wrong: bad shape, wrong algorithm, bad signature, expired. */
export async function verifyAccessToken(secret: string, token: string, now: Date): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64Url(h))) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64Url(s), utf8(`${h}.${b}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64Url(b))) as Partial<AccessClaims>;
    if (typeof c.sub !== "string" || typeof c.sid !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number") return null;
    if (c.exp <= Math.floor(now.getTime() / 1000)) return null;
    return c as AccessClaims;
  } catch {
    return null;
  }
}

export function newRefreshToken(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Refresh tokens are 256 random bits, so a plain SHA-256 is enough; the database never holds the token itself. */
export async function hashRefreshToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(token)));
  return toB64Url(digest);
}

export { constantTimeEqual };
