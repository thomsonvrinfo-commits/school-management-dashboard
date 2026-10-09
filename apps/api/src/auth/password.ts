/**
 * Password hashing with PBKDF2-SHA256 through WebCrypto (available in Workers and Node).
 * Cloudflare Workers has, as far as I know, a cap of 100,000 PBKDF2 iterations; that is the value used.
 * It is below current OWASP guidance for PBKDF2 (600,000), so this is a known, documented compromise
 * of the platform: raise it, or move to a memory-hard hash, if the platform allows.
 * The iteration count is stored in each hash, so it can be raised later without breaking existing passwords.
 */
import { constantTimeEqual, fromB64Url, toB64Url, utf8 } from "../encoding.ts";

export const PBKDF2_ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toB64Url(salt)}$${toB64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) return false;
  const actual = await derive(password, fromB64Url(salt), iterations);
  return constantTimeEqual(actual, fromB64Url(hash));
}
