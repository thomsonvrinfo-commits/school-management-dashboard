/**
 * The only module that talks to the network. It distinguishes the two kinds of failure the rest of the app
 * must treat differently:
 *  - NetworkFailure: no answer (offline, timeout, server error). Keep the data, try again later.
 *  - ApiFailure: the server answered and said no. The reason is in `code`.
 */
import type {
  AttendanceSummaryResponse, BootstrapResponse, LoginRequest, PushRequest, PushResponse, TokenResponse,
} from "@schoolpulse/contracts";
import { getDeviceId, getStoredSession, saveStoredSession } from "./session.ts";
import { createStore } from "./store.ts";

export class NetworkFailure extends Error {
  constructor(message = "No connection to the server.") {
    super(message);
    this.name = "NetworkFailure";
  }
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
  }
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

/** The access token lives in memory only. The refresh token (in IndexedDB) can mint a new one. */
let access: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<void> | null = null;

/** True when the server has said this device's sign-in is no longer valid. Local data is kept. */
export const sessionExpired = createStore(false);

export function setAccessToken(tokens: Pick<TokenResponse, "accessToken" | "accessTokenExpiresAt">): void {
  access = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessTokenExpiresAt) };
}

export function clearAccessToken(): void {
  access = null;
}

async function send(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new NetworkFailure();
  }
}

async function readOrThrow<T>(res: Response): Promise<T> {
  if (res.status >= 500) throw new NetworkFailure(`The server had a problem (${res.status}).`);
  if (res.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiFailure(res.status, err?.code ?? "unknown", err?.message ?? "The request was refused.");
  }
  return payload as T;
}

async function refreshAccess(): Promise<void> {
  const session = await getStoredSession();
  if (!session) throw new ApiFailure(401, "invalid_session", "Please sign in again.");
  const res = await send("POST", "/v1/auth/refresh", { refreshToken: session.refreshToken, deviceId: await getDeviceId() });
  try {
    const tokens = await readOrThrow<TokenResponse>(res);
    setAccessToken(tokens);
    // The refresh token rotates: store the new one straight away or the next refresh would fail.
    await saveStoredSession({ refreshToken: tokens.refreshToken, me: tokens.me });
    sessionExpired.set(false);
  } catch (e) {
    if (e instanceof ApiFailure && (e.code === "invalid_session" || e.status === 401)) {
      access = null;
      sessionExpired.set(true);
    }
    throw e;
  }
}

async function ensureAccess(): Promise<string> {
  if (!access || access.expiresAt - Date.now() < 30_000) {
    refreshing ??= refreshAccess().finally(() => {
      refreshing = null;
    });
    await refreshing;
  }
  return access!.token;
}

async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await send(method, path, body, await ensureAccess());
  if (res.status === 401) {
    access = null; // the token was refused (revoked or clock skew): get a fresh one once
    res = await send(method, path, body, await ensureAccess());
  }
  return readOrThrow<T>(res);
}

export const api = {
  async login(req: LoginRequest): Promise<TokenResponse> {
    return readOrThrow<TokenResponse>(await send("POST", "/v1/auth/login", req));
  },
  async logout(refreshToken: string): Promise<void> {
    await readOrThrow<void>(await send("POST", "/v1/auth/logout", { refreshToken }));
  },
  bootstrap: () => authed<BootstrapResponse>("GET", "/v1/sync/bootstrap"),
  push: (req: PushRequest) => authed<PushResponse>("POST", "/v1/sync/push", req),
  attendanceSummary: (query: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString();
    return authed<AttendanceSummaryResponse>("GET", `/v1/admin/attendance/summary${qs ? `?${qs}` : ""}`);
  },
};
