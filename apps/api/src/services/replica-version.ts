/**
 * A fingerprint of what a teacher's phone is allowed to hold. The phone sends it back (`?since=`); if it still matches,
 * the server says "unchanged" in a few dozen bytes instead of sending the whole replica again.
 *
 * It is a SHA-256 of the replica's contents (not of the time it was made), so it changes exactly when something the phone
 * would show changes, and it can be computed again by any server instance without storing anything.
 */
import { toB64Url, utf8 } from "../encoding.ts";

/** JSON with object keys in sorted order, so the same data always gives the same text whatever order it was built in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * `userId` is part of what is hashed so that two people's versions never coincide by accident; it is not part of the output.
 * 43 characters of base64url, the same shape as the other digests in this API.
 */
export async function replicaVersion(userId: string, replica: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonicalJson({ userId, replica }))));
  return toB64Url(digest);
}
