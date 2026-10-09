import { getMeta, setMeta, db, type StoredSession } from "./db.ts";

/** A random id that identifies this phone/browser to the server. It never changes for this install. */
export async function getDeviceId(): Promise<string> {
  const existing = await getMeta<string>("deviceId");
  if (existing) return existing;
  const id = crypto.randomUUID().replace(/-/g, "");
  await setMeta("deviceId", id);
  return id;
}

export const getStoredSession = () => getMeta<StoredSession>("session");
export const saveStoredSession = (s: StoredSession) => setMeta("session", s);
export const clearStoredSession = async () => {
  await db.meta.delete("session");
};
