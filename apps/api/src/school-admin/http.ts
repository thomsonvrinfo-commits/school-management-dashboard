/**
 * The framework-free HTTP layer for school administration. A handler gets the already-authenticated caller and a tiny
 * request view (path params, query string, a way to read the JSON body) and returns a status and a body. Hono just
 * adapts to this in app.ts, so everything that decides a status code, validates input, or enforces the role gate is
 * plain code that the tests run directly against a real database.
 */
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";

export interface AdminRequest {
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | undefined>>;
  json(): Promise<unknown>;
}

export interface AdminResponse {
  status: 200 | 201 | 204;
  body?: unknown;
}

export type AdminHandler = (deps: Deps, auth: AuthContext, req: AdminRequest) => Promise<AdminResponse>;

type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** Turns the first problem zod found into a 400 that names the field. */
export function invalid(issue: z.ZodIssue | undefined): HttpError {
  const path = issue?.path ?? [];
  const field = path.length > 0 ? String(path[0]) : undefined;
  const where = path.join(".") || "request";
  return new HttpError(400, "invalid_request", `${where}: ${issue?.message ?? "invalid"}`, field);
}

export function parseWith<T>(schema: Schema<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]);
  return parsed.data;
}

export async function readBody<T>(req: AdminRequest, schema: Schema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
  return parseWith(schema, raw);
}

/** Query strings: only declared keys are read; anything else is ignored. Empty values count as absent. */
export function readQuery<T>(req: AdminRequest, schema: Schema<T>): T {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (v !== undefined && v !== "") cleaned[k] = v;
  return parseWith(schema, cleaned);
}

/** A path parameter that must be a UUID. A malformed id is a 404 (there is no such resource), not a server error. */
export function idParam(req: AdminRequest, name: string, uuidSchema: Schema<string>): string {
  const parsed = uuidSchema.safeParse(req.params[name]);
  if (!parsed.success) throw new HttpError(404, "not_found", "Not found.");
  return parsed.data;
}
