/**
 * Authorization policy. One pure function, deny by default.
 * The caller supplies facts it looked up (e.g. whether the teacher teaches the class);
 * this module only decides. Hiding a menu item is never the control: this is.
 */

export const ROLES = ["head", "teacher"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "sync:bootstrap",
  "attendance:record",
  "attendance:read-class",
  "attendance:summary",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Principal {
  userId: string;
  schoolId: string;
  role: Role;
}

export interface Resource {
  /** The school the data belongs to. Must equal the principal's school. */
  schoolId: string;
  classId?: string;
  /** Looked up by the caller: does this principal teach `classId`? */
  teachesClass?: boolean;
}

export interface Decision {
  allowed: boolean;
  reason: "ok" | "wrong_school" | "role_not_permitted" | "not_assigned_to_class" | "unknown_action";
}

const allow: Decision = { allowed: true, reason: "ok" };
const deny = (reason: Exclude<Decision["reason"], "ok">): Decision => ({ allowed: false, reason });

export function authorize(principal: Principal, action: string, resource: Resource): Decision {
  // Tenant boundary first, for every action.
  if (resource.schoolId !== principal.schoolId) return deny("wrong_school");

  switch (action as Action) {
    case "sync:bootstrap":
      return principal.role === "teacher" ? allow : deny("role_not_permitted");

    case "attendance:record":
      if (principal.role !== "teacher") return deny("role_not_permitted");
      return resource.teachesClass === true ? allow : deny("not_assigned_to_class");

    case "attendance:read-class":
      if (principal.role === "head") return allow;
      if (principal.role !== "teacher") return deny("role_not_permitted");
      return resource.teachesClass === true ? allow : deny("not_assigned_to_class");

    case "attendance:summary":
      return principal.role === "head" ? allow : deny("role_not_permitted");

    default:
      return deny("unknown_action");
  }
}

/**
 * Coarse gate: could this role ever perform the action? Used to refuse a whole request early.
 * It never replaces the per-resource `authorize` check, which still runs for every record.
 */
export function roleMayAttempt(principal: Principal, action: Action): boolean {
  return authorize(principal, action, { schoolId: principal.schoolId, teachesClass: true }).allowed;
}
