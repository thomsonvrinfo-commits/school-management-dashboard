/**
 * Invitation and reset links carry their secret in the part of the address after "#". A browser never sends that part
 * to any server (so it is not in access logs) nor in a Referer header. The page reads it once, keeps it in memory, and
 * takes it out of the address bar so it does not linger in the history or get copied by accident.
 *
 * Pure: the caller hands in the location and a storage object, so it runs under `node --test`.
 */
import { linkToken } from "@schoolpulse/contracts";

export type LinkKind = "accept" | "reset";

type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The token in "#token=...", or null when it is missing or not shaped like a token. */
export function readLinkToken(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  if (raw === null) return null;
  const parsed = linkToken.safeParse(raw.trim());
  return parsed.success ? parsed.data : null;
}

const key = (kind: LinkKind) => `schoolpulse:link:${kind}`;

/**
 * The token for this page: from the address if it is there (and then remembered for this tab only, so a reload does not
 * lose it), otherwise from what this tab remembered. `storage` may be null or throw (private windows): then the token
 * simply is not remembered.
 */
export function takeLinkToken(kind: LinkKind, hash: string, storage: TokenStorage | null): { token: string | null; scrub: boolean } {
  const fromAddress = readLinkToken(hash);
  if (fromAddress) {
    try {
      storage?.setItem(key(kind), fromAddress);
    } catch {
      /* not remembered: fine */
    }
    return { token: fromAddress, scrub: true };
  }
  try {
    const remembered = storage?.getItem(key(kind)) ?? null;
    const parsed = remembered === null ? null : linkToken.safeParse(remembered);
    return { token: parsed?.success ? parsed.data : null, scrub: hash !== "" };
  } catch {
    return { token: null, scrub: hash !== "" };
  }
}

/** Forget the token once it has been used (or has proved useless). */
export function forgetLinkToken(kind: LinkKind, storage: TokenStorage | null): void {
  try {
    storage?.removeItem(key(kind));
  } catch {
    /* nothing to forget */
  }
}

/** The address a person is given. `origin` is the app's own address, with no trailing slash needed. */
export function linkUrl(origin: string, kind: LinkKind, token: string): string {
  return `${origin.replace(/\/+$/, "")}/${kind}#token=${token}`;
}
