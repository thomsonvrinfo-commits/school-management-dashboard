import { z } from "zod";
import { ROLES, isIsoDate } from "@schoolpulse/domain";

export const uuid = z.string().uuid();
export const isoDate = z.string().refine(isIsoDate, "Expected a real calendar date as YYYY-MM-DD");

export const role = z.enum(ROLES);
export const deviceId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const meResponse = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string() }),
  school: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  role,
});
export type MeResponse = z.infer<typeof meResponse>;

export const tokenResponse = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
  me: meResponse,
});
export type TokenResponse = z.infer<typeof tokenResponse>;
