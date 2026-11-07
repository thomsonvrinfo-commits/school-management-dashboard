/**
 * Tells "the database refused this because of a constraint" apart from "something broke", and names the constraint,
 * so the API can turn a race that slipped past the friendly pre-checks into the same clear message.
 *
 * postgres.js errors carry the SQLSTATE in `code` and the constraint in `constraint_name`. The psql-driven test
 * runner only has the message text, so the same facts are read from PostgreSQL's fixed message wording as a fallback.
 */
export type DbErrorKind = "unique" | "exclusion" | "foreign_key" | "check" | "not_null" | "other";

export interface DbErrorInfo {
  kind: DbErrorKind;
  constraint: string | null;
}

const SQLSTATE: Record<string, DbErrorKind> = {
  "23505": "unique",
  "23P01": "exclusion",
  "23503": "foreign_key",
  "23514": "check",
  "23502": "not_null",
};

const PATTERNS: [RegExp, DbErrorKind][] = [
  [/violates unique constraint "([^"]+)"/, "unique"],
  [/conflicting key value violates exclusion constraint "([^"]+)"/, "exclusion"],
  [/violates foreign key constraint "([^"]+)"/, "foreign_key"],
  [/violates check constraint "([^"]+)"/, "check"],
  // Raised by the class_teachers trigger in 0002, which names itself first in the message.
  [/(class_teachers_teacher_membership):/, "check"],
];

export function classifyDbError(err: unknown): DbErrorInfo {
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  const named = typeof e?.constraint_name === "string" ? e.constraint_name : typeof e?.constraint === "string" ? e.constraint : null;

  if (typeof e?.code === "string" && SQLSTATE[e.code]) {
    const kind = SQLSTATE[e.code]!;
    if (named) return { kind, constraint: named };
    for (const [re, k] of PATTERNS) {
      const m = re.exec(message);
      if (m && k === kind) return { kind, constraint: m[1] ?? null };
    }
    return { kind, constraint: null };
  }
  for (const [re, kind] of PATTERNS) {
    const m = re.exec(message);
    if (m) return { kind, constraint: m[1] ?? null };
  }
  if (/null value in column/.test(message)) return { kind: "not_null", constraint: null };
  return { kind: "other", constraint: null };
}
