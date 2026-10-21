/**
 * The browser security headers for the web app, as data. One list of rules is the single source for three things: the
 * `_headers` file that Cloudflare Pages reads, the local server that lets you (and the end-to-end test) see the app
 * behind the same headers, and the unit tests. Pure: no file or network access, so it runs under `node --test`.
 *
 * Why these choices:
 *  - Scripts and connections may only go to the app's own origin and the API's origin. A script injected into a page
 *    (the usual way a child's data would leak from a school web app) cannot load code from anywhere else, and cannot send
 *    what it finds to anywhere but the API.
 *  - `style-src` keeps 'unsafe-inline' because React sets the width of a progress bar through the style attribute. An
 *    inline style cannot run code, so the cost is small; blocking it would break layout on phones nobody can test from here.
 *  - The app can never be shown inside another site's frame (clickjacking), never sends a Referer, and never asks for the
 *    camera, microphone or location.
 */

/** The address the web app's API calls go to, as an origin. Empty or missing means "the same origin as the app". */
export function apiOriginOf(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  // The value ends up inside a security policy: refuse anything that is not a plain origin rather than try to clean it.
  if (/[\s;,'"*\\]/.test(value)) throw new Error(`VITE_API_URL is not a plain web address: ${JSON.stringify(value)}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_API_URL is not a web address: ${JSON.stringify(value)}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`VITE_API_URL must start with https:// (http:// is only allowed for localhost): ${JSON.stringify(value)}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error(`VITE_API_URL must be just the address, with no path, query or login: ${JSON.stringify(value)}`);
  }
  return url.origin;
}

export interface HeaderOptions {
  /** From apiOriginOf. */
  apiOrigin: string | null;
}

export function contentSecurityPolicy(opts: HeaderOptions): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${opts.apiOrigin ? ` ${opts.apiOrigin}` : ""}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export interface HeaderRule {
  /** An exact path ("/sw.js"), or a prefix ending in "/*" ("/assets/*"). "/*" is everything. */
  pattern: string;
  headers: Readonly<Record<string, string>>;
}

export function headerRules(opts: HeaderOptions): HeaderRule[] {
  return [
    {
      pattern: "/*",
      headers: {
        "Content-Security-Policy": contentSecurityPolicy(opts),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Strict-Transport-Security": "max-age=15552000",
      },
    },
    // Built files have a fingerprint in their name, so they can be kept for a year; the page and the service worker
    // must be checked on every visit or a school would be stuck on an old version.
    { pattern: "/assets/*", headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
    { pattern: "/index.html", headers: { "Cache-Control": "no-cache" } },
    { pattern: "/sw.js", headers: { "Cache-Control": "no-cache" } },
    { pattern: "/registerSW.js", headers: { "Cache-Control": "no-cache" } },
    { pattern: "/manifest.webmanifest", headers: { "Cache-Control": "no-cache" } },
  ];
}

const matches = (pattern: string, path: string): boolean =>
  pattern === "/*" ? true : pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

/** The headers a response for `path` carries: every matching rule, later rules adding to earlier ones. */
export function headersFor(path: string, rules: readonly HeaderRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) if (matches(rule.pattern, path)) Object.assign(out, rule.headers);
  return out;
}

/** The Cloudflare Pages `_headers` file: a path, then its headers indented beneath it. */
export function headersFile(rules: readonly HeaderRule[]): string {
  return `${rules.map((r) => [r.pattern, ...Object.entries(r.headers).map(([k, v]) => `  ${k}: ${v}`)].join("\n")).join("\n\n")}\n`;
}
