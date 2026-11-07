/**
 * P1 wire contracts: the head's activity screen. Read-only. The school always comes from the signed-in session.
 * What an entry SAYS is decided on the server (packages/domain/audit-view): the raw `details` are never sent.
 */
import { z } from "zod";
import { isoDate, uuid } from "./primitives.ts";

export const auditCategory = z.enum(["students", "classes", "attendance", "staff", "school"]);
export type AuditCategoryFilter = z.infer<typeof auditCategory>;

export const auditQuery = z
  .object({
    category: auditCategory.optional(),
    /** Only what this person did. */
    actor: uuid.optional(),
    /** Inclusive school days. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** The `nextBefore` of the previous page: only older entries come back. Digits only (it is a database sequence number). */
    before: z.string().regex(/^[1-9]\d{0,17}$/, "Not a valid page marker").optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "The start date is after the end date.", path: ["from"] });
export type AuditQuery = z.input<typeof auditQuery>;
export type AuditParams = z.output<typeof auditQuery>;

export const auditItem = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ id: uuid, name: z.string() }),
  category: z.enum(["students", "classes", "attendance", "staff", "school", "other"]),
  /** What was done, in words: "Registered a student". */
  summary: z.string(),
  /** One line of context, or null. Never an identifier or a child's details. */
  detail: z.string().nullable(),
  /** What the entry is about, so the screen can link to it while it still exists. */
  entity: z.object({ type: z.string(), id: uuid.nullable() }),
});
export type AuditItem = z.infer<typeof auditItem>;

export const auditPage = z.object({
  items: z.array(auditItem),
  /** Pass this as `before` to get the next, older page; null when there is nothing older. */
  nextBefore: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPage>;
