import type { Action } from "@schoolpulse/domain";

/**
 * The API surface as data. Every route says who may call it; a test fails if a protected route has no policy
 * or if a new public route appears without this file changing. The services enforce the policy; this table keeps it visible.
 */
export type Access = "public" | "authenticated" | { action: Action };

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RouteSpec {
  method: Method;
  path: string;
  access: Access;
}

/** Slice 1: sign-in, offline sync, the head's attendance summary. */
const SLICE_1: readonly RouteSpec[] = [
  { method: "POST", path: "/v1/auth/login", access: "public" },
  { method: "POST", path: "/v1/auth/refresh", access: "public" },
  { method: "POST", path: "/v1/auth/logout", access: "public" },
  { method: "GET", path: "/v1/me", access: "authenticated" },
  { method: "GET", path: "/v1/sync/bootstrap", access: { action: "sync:bootstrap" } },
  { method: "POST", path: "/v1/sync/push", access: { action: "attendance:record" } },
  { method: "GET", path: "/v1/admin/attendance/summary", access: { action: "attendance:summary" } },
];

/**
 * Slice 2: school administration. `:id`, `:placementId` and `:userId` are always resolved INSIDE the signed-in user's
 * school; the school itself is never a parameter and never read from a body.
 */
export const SCHOOL_ADMIN_ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/v1/school", access: { action: "school:read" } },
  { method: "PATCH", path: "/v1/school", access: { action: "school:manage" } },

  { method: "GET", path: "/v1/academic-years", access: { action: "school:read" } },
  { method: "POST", path: "/v1/academic-years", access: { action: "school:manage" } },
  { method: "PATCH", path: "/v1/academic-years/:id", access: { action: "school:manage" } },
  { method: "DELETE", path: "/v1/academic-years/:id", access: { action: "school:manage" } },
  { method: "POST", path: "/v1/academic-years/:id/terms", access: { action: "school:manage" } },
  { method: "PATCH", path: "/v1/terms/:id", access: { action: "school:manage" } },
  { method: "DELETE", path: "/v1/terms/:id", access: { action: "school:manage" } },

  { method: "GET", path: "/v1/students", access: { action: "student:read" } },
  { method: "POST", path: "/v1/students", access: { action: "student:manage" } },
  { method: "GET", path: "/v1/students/:id", access: { action: "student:read" } },
  { method: "PATCH", path: "/v1/students/:id", access: { action: "student:manage" } },
  { method: "POST", path: "/v1/students/:id/status", access: { action: "student:manage" } },
  { method: "POST", path: "/v1/students/:id/placements", access: { action: "student:manage" } },
  { method: "DELETE", path: "/v1/students/:id/placements/:placementId", access: { action: "student:manage" } },

  { method: "GET", path: "/v1/classes", access: { action: "class:read" } },
  { method: "POST", path: "/v1/classes", access: { action: "class:manage" } },
  { method: "GET", path: "/v1/classes/:id", access: { action: "class:read" } },
  { method: "PATCH", path: "/v1/classes/:id", access: { action: "class:manage" } },
  { method: "GET", path: "/v1/classes/:id/roster", access: { action: "class:read-roster" } },
  { method: "POST", path: "/v1/classes/:id/teachers", access: { action: "teacher:assign" } },
  { method: "DELETE", path: "/v1/classes/:id/teachers/:userId", access: { action: "teacher:assign" } },

  { method: "GET", path: "/v1/teachers", access: { action: "teacher:read" } },
  { method: "GET", path: "/v1/me/classes", access: { action: "teaching:own-classes" } },
];

export const ROUTES: readonly RouteSpec[] = [...SLICE_1, ...SCHOOL_ADMIN_ROUTES];

export const routeKey = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
