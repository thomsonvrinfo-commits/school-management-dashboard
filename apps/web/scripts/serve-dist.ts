/**
 * Serves the built app (dist/) with the SAME security headers Cloudflare Pages will send, plus the single-page-app
 * fallback. For checking the app by hand or in the end-to-end test before anything is deployed:
 *
 *     npm run build:web && npm run serve:web          (then open http://localhost:4173)
 *
 * Requests under /v1/ are not answered here (404): point VITE_API_URL at a running API, or run the API on its own port.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { apiOriginOf, headerRules, headersFor } from "./security-headers.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const rules = headerRules({ apiOrigin: apiOriginOf(process.env.VITE_API_URL) });
const port = Number(process.env.PORT ?? 4173);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".json": "application/json", ".ico": "image/x-icon",
};

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  let file = normalize(join(dist, path));
  // Never serve anything outside dist/.
  if (file !== dist && !file.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (path.startsWith("/v1/")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "No API behind this server." } }));
    return;
  }
  let served = path;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(dist, "index.html"); // single-page-app fallback, like Pages' "/* /index.html 200"
    served = "/index.html";
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...headersFor(served, rules) }).end(readFileSync(file));
}).listen(port, () => console.log(`Serving dist/ with the production security headers at http://localhost:${port}`));
