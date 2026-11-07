/**
 * Writes dist/_headers after `vite build`, using the API address the app was built for (VITE_API_URL), so the policy
 * allows exactly the origin the app really talks to. A bad address stops the build instead of producing a policy that
 * is too wide or that blocks the API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiOriginOf, headerRules, headersFile } from "./security-headers.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const apiOrigin = apiOriginOf(process.env.VITE_API_URL);
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "_headers"), headersFile(headerRules({ apiOrigin })));
console.log(`Wrote dist/_headers (API allowed: ${apiOrigin ?? "same origin only"})`);
