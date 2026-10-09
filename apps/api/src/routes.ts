import type { Action } from "@schoolpulse/domain";

/**
 * The API surface as data. Every route says who may call it; a test fails if a protected route has no policy
 * or if a new public route appears without this file changing. The services enforce the policy; this table keeps it visible.
 */
export type Access = "public" | "authenticated" | { action: Action };

export interface RouteSpec {
  method: "GET" | "POST";
  path: string;
  access: Access;
}

export const ROUTES: readonly RouteSpec[] = [
  { method: "POST", path: "/v1/auth/login", access: "public" },
  { method: "POST", path: "/v1/auth/refresh", access: "public" },
  { method: "POST", path: "/v1/auth/logout", access: "public" },
  { method: "GET", path: "/v1/me", access: "authenticated" },
  { method: "GET", path: "/v1/sync/bootstrap", access: { action: "sync:bootstrap" } },
  { method: "POST", path: "/v1/sync/push", access: { action: "attendance:record" } },
  { method: "GET", path: "/v1/admin/attendance/summary", access: { action: "attendance:summary" } },
];
