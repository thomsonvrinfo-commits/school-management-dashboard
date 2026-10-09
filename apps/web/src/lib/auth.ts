import type { MeResponse } from "@schoolpulse/contracts";
import { ApiFailure, NetworkFailure, api, clearAccessToken, sessionExpired, setAccessToken } from "./api.ts";
import { db, wipeLocalData } from "./db.ts";
import { clearStoredSession, getDeviceId, getStoredSession, saveStoredSession } from "./session.ts";
import { createStore } from "./store.ts";
import { loadQueue, startSyncEngine, syncNow } from "./sync-engine.ts";

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; me: MeResponse };

export const authStore = createStore<AuthState>({ status: "loading" });

let stopEngine: (() => void) | null = null;

function begin(me: MeResponse) {
  authStore.set({ status: "signedIn", me });
  // Only teachers work from the offline replica.
  if (me.role === "teacher" && !stopEngine) stopEngine = startSyncEngine();
}

/** On app start: if this phone has a stored sign-in, use it straight away, even with no connection. */
export async function restoreSession(): Promise<void> {
  const session = await getStoredSession();
  if (!session) {
    authStore.set({ status: "signedOut" });
    return;
  }
  begin(session.me);
}

export async function signIn(input: { email: string; password: string }): Promise<void> {
  const tokens = await api.login({ ...input, deviceId: await getDeviceId() });

  // If a different person signs in on this phone, their predecessor's data must not stay behind.
  const previous = await getStoredSession();
  if (previous && previous.me.user.id !== tokens.me.user.id) {
    const waiting = await db.ops.count();
    if (waiting > 0 && !window.confirm(`${previous.me.user.name} still has ${waiting} unsynced change${waiting === 1 ? "" : "s"} on this phone. Signing in as someone else will discard them. Continue?`)) {
      await api.logout(tokens.refreshToken).catch(() => {});
      throw new Error("Sign-in cancelled so that unsynced changes are kept.");
    }
    await wipeLocalData();
  }

  setAccessToken(tokens);
  sessionExpired.set(false);
  await saveStoredSession({ refreshToken: tokens.refreshToken, me: tokens.me });
  begin(tokens.me);
}

export async function signOut(): Promise<void> {
  const session = await getStoredSession();
  if (session?.me.role === "teacher") {
    // Try to send anything still waiting before this phone forgets the teacher.
    await syncNow().catch(() => {});
    const waiting = (await loadQueue()).length;
    if (waiting > 0 && !window.confirm(`${waiting} change${waiting === 1 ? " has" : "s have"} not synced yet. Signing out will discard ${waiting === 1 ? "it" : "them"}. Sign out anyway?`)) return;
  }
  if (session) await api.logout(session.refreshToken).catch((e) => {
    if (!(e instanceof NetworkFailure) && !(e instanceof ApiFailure)) throw e;
  });
  stopEngine?.();
  stopEngine = null;
  clearAccessToken();
  await clearStoredSession();
  await wipeLocalData();
  sessionExpired.set(false);
  authStore.set({ status: "signedOut" });
}
