/**
 * The HTTP layer. Deliberately thin: parse input with the shared contracts, call a service, return JSON.
 * All rules (permissions, idempotency, conflicts, calculations) live in services and packages/domain.
 * Routes are registered FROM `ROUTES`, so the policy table and the real API cannot drift apart.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ZodType } from "zod";
import { loginRequest, logoutRequest, pushRequest, refreshRequest, summaryQuery } from "@schoolpulse/contracts";
import type { Deps } from "./deps.ts";
import { HttpError } from "./errors.ts";
import { ROUTES } from "./routes.ts";
import { authenticate, login, logout, meOf, refresh, type AuthContext } from "./services/auth.ts";
import { bootstrap, push } from "./services/sync.ts";
import { attendanceSummary } from "./services/admin.ts";

export interface Env {
  HYPERDRIVE: { connectionString: string };
  AUTH_SECRET: string;
  ENVIRONMENT?: string;
  ALLOWED_ORIGIN?: string;
}

interface Vars {
  deps: Deps;
  auth: AuthContext;
}
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export interface DepsFactory {
  (env: Env): { deps: Deps; dispose(): Promise<void> };
}

async function readBody<T>(c: Ctx, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, "invalid_request", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

type Handler = (c: Ctx) => Promise<Response>;

const handlers: Record<string, Handler> = {
  "POST /v1/auth/login": async (c) => c.json(await login(c.get("deps"), await readBody(c, loginRequest))),
  "POST /v1/auth/refresh": async (c) => c.json(await refresh(c.get("deps"), await readBody(c, refreshRequest))),
  "POST /v1/auth/logout": async (c) => {
    await logout(c.get("deps"), (await readBody(c, logoutRequest)).refreshToken);
    return c.body(null, 204);
  },
  "GET /v1/me": async (c) => c.json(meOf(c.get("auth").ctx)),
  "GET /v1/sync/bootstrap": async (c) => c.json(await bootstrap(c.get("deps"), c.get("auth"))),
  "POST /v1/sync/push": async (c) => c.json(await push(c.get("deps"), c.get("auth"), await readBody(c, pushRequest))),
  "GET /v1/admin/attendance/summary": async (c) => {
    const q = summaryQuery.safeParse(c.req.query());
    if (!q.success) throw new HttpError(400, "invalid_request", q.error.issues[0]?.message ?? "invalid query");
    return c.json(await attendanceSummary(c.get("deps"), c.get("auth"), q.data));
  },
};

export function createApp(makeDeps: DepsFactory) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use("*", cors({
    origin: (origin, c) => (origin && origin === c.env.ALLOWED_ORIGIN ? origin : undefined),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }));
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
  });
  app.use("*", bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: { code: "payload_too_large", message: "The request is too large." } }, 413),
  }));
  app.use("*", async (c, next) => {
    const { deps, dispose } = makeDeps(c.env);
    c.set("deps", deps);
    try {
      await next();
    } finally {
      c.executionCtx.waitUntil(dispose());
    }
  });

  const needsAuth = async (c: Ctx, next: () => Promise<void>) => {
    c.set("auth", await authenticate(c.get("deps"), c.req.header("authorization")));
    await next();
  };

  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`No handler for ${key}`);
    if (route.access === "public") app.on(route.method, route.path, handler);
    else app.on(route.method, route.path, needsAuth, handler);
  }
  const known = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const key of Object.keys(handlers)) if (!known.has(key)) throw new Error(`Handler without a policy entry: ${key}`);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 401 | 403 | 404 | 409);
    }
    console.error("Unhandled error", err);
    return c.json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } }, 500);
  });
  return app;
}
