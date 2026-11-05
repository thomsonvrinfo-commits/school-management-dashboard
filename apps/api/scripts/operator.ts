/**
 * Platform-operator commands, run from a terminal by whoever holds the database credentials.
 *
 *   DATABASE_URL=postgres://... node --no-warnings apps/api/scripts/operator.ts <command> [options] [--apply]
 *
 *   create-school --name "Mavambo Academy" --head-email head@school.example [--head-name "Mr. Mbewe"] [--code MAV] [--timezone Africa/Harare]
 *   invite-head   --school MAV --head-email head@school.example [--head-name "..."]
 *   reset-head    --school MAV --head-email head@school.example
 *
 * SAFE BY DEFAULT: without --apply nothing is written and the database is never opened; the command only checks that the
 * required options are present and says which database it WOULD act on (host and name only, never the password). The rest
 * (a valid email, a school that exists, a person not already on the staff) is checked only when --apply runs. Add --apply to do it. The link it prints is the only
 * time its secret is shown; hand it to the head teacher yourself (it is meant for one person and works once).
 */
import postgres from "postgres";
import { createStaffDb } from "@schoolpulse/db";
import { postgresJsRunner } from "@schoolpulse/db/postgres-js";
import { createSchoolWithHead, inviteHead, OperatorError, resetHeadPassword, type OperatorDeps } from "../src/staff/operator.ts";

const USAGE = `Usage: operator.ts <create-school|invite-head|reset-head> [options] [--apply]
  create-school --name <name> --head-email <email> [--head-name <name>] [--code <code>] [--timezone <zone>]
  invite-head   --school <code> --head-email <email> [--head-name <name>]
  reset-head    --school <code> --head-email <email>`;

function parse(argv: string[]): { command: string; flags: Map<string, string>; apply: boolean } {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") apply = true;
    else if (a.startsWith("--")) {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new OperatorError(`${a} needs a value.\n${USAGE}`);
      flags.set(a.slice(2), v);
    } else throw new OperatorError(`Unexpected "${a}".\n${USAGE}`);
  }
  return { command, flags, apply };
}

const need = (flags: Map<string, string>, name: string): string => flags.get(name) ?? (() => { throw new OperatorError(`--${name} is required.\n${USAGE}`); })();

function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unreadable DATABASE_URL)";
  }
}

const url = process.env.DATABASE_URL;
try {
  const { command, flags, apply } = parse(process.argv.slice(2));
  if (!["create-school", "invite-head", "reset-head"].includes(command)) throw new OperatorError(USAGE);
  if (!url) throw new OperatorError("DATABASE_URL is required.");

  console.log(`Database: ${describeTarget(url)}`);
  console.log(apply ? "Mode: APPLY (changes will be written)" : "Mode: dry run (nothing will be written). Add --apply to do it.");
  if (!apply) {
    // Without --apply the database is never opened.
    need(flags, "head-email");
    if (command === "create-school") need(flags, "name");
    else need(flags, "school");
    console.log("All required options are present. The rest is checked against the database only with --apply. Nothing was changed.");
  } else {
    const sql = postgres(url, { max: 1 });
    try {
      const deps: OperatorDeps = { staff: createStaffDb(postgresJsRunner(sql)), now: () => new Date(), newId: () => crypto.randomUUID() };
      const headEmail = need(flags, "head-email");
      const headName = flags.get("head-name");
      const show = (what: string, school: string, token: string, expiresAt: string, path: string, warnings: string[] = []) => {
        for (const w of warnings) console.log(`Note: ${w}`);
        console.log(`${what} for ${school}. Valid until ${expiresAt}.`);
        console.log(`Give the head teacher this link (shown once, works once):\n  <your app address>/${path}#token=${token}`);
      };
      if (command === "create-school") {
        const r = await createSchoolWithHead(deps, {
          name: need(flags, "name"), headEmail, ...(headName ? { headName } : {}),
          ...(flags.has("code") ? { code: flags.get("code")! } : {}), ...(flags.has("timezone") ? { timezone: flags.get("timezone")! } : {}),
        });
        console.log(`Created ${r.school.name} (id ${r.school.id}${r.school.code ? `, code ${r.school.code}` : ""}).`);
        show("Invitation", r.school.name, r.invitation.token, r.invitation.expiresAt, "accept");
      } else if (command === "invite-head") {
        const r = await inviteHead(deps, { schoolCode: need(flags, "school"), headEmail, ...(headName ? { headName } : {}) });
        show("Invitation", r.school.name, r.invitation.token, r.invitation.expiresAt, "accept", r.warnings);
      } else {
        const r = await resetHeadPassword(deps, { schoolCode: need(flags, "school"), headEmail });
        show(`Password reset for ${r.headName}`, r.school.name, r.reset.token, r.reset.expiresAt, "reset", r.warnings);
      }
    } finally {
      await sql.end();
    }
  }
} catch (e) {
  if (e instanceof OperatorError) {
    console.error(e.message);
    process.exitCode = 1;
  } else throw e;
}
