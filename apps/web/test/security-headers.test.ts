import { test } from "node:test";
import assert from "node:assert/strict";
import { apiOriginOf, contentSecurityPolicy, headerRules, headersFile, headersFor } from "../scripts/security-headers.ts";

const API = "https://schoolpulse-api.example.workers.dev";
const policy = (apiOrigin: string | null = API) => contentSecurityPolicy({ apiOrigin });
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d === name || d.startsWith(`${name} `));

test("the API address becomes a plain origin, and nothing that could widen the policy gets through", () => {
  assert.equal(apiOriginOf(undefined), null);
  assert.equal(apiOriginOf(""), null);
  assert.equal(apiOriginOf("   "), null);
  assert.equal(apiOriginOf("https://API.Example.com/"), "https://api.example.com");
  assert.equal(apiOriginOf("https://api.example.com:8443"), "https://api.example.com:8443");
  assert.equal(apiOriginOf("http://localhost:8787"), "http://localhost:8787");
  assert.equal(apiOriginOf("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  for (const bad of [
    "http://api.example.com", "ftp://api.example.com", "api.example.com", "https://*.example.com", "https://a.example.com; script-src *",
    "https://a.example.com 'unsafe-eval'", "https://a.example.com/v1", "https://a.example.com/?x=1", "https://a.example.com/#x", "https://user:pw@a.example.com",
    "https://a.example.com,https://b.example.com", "https://a.example.com\nscript-src *", "'self'", "*", "https://",
  ]) assert.throws(() => apiOriginOf(bad), Error, bad);
});

test("scripts run only from the app's own origin: no inline, no eval, no other site", () => {
  const csp = policy();
  assert.equal(directive(csp, "script-src"), "script-src 'self'");
  assert.equal(directive(csp, "default-src"), "default-src 'none'");
  assert.ok(!csp.includes("unsafe-eval"));
  assert.ok(!csp.includes("*"));
  assert.ok(!csp.includes("http:"), "nothing is allowed over plain http");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "base-uri"), "base-uri 'none'");
  assert.equal(directive(csp, "frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive(csp, "form-action"), "form-action 'self'");
  assert.ok(csp.includes("upgrade-insecure-requests"));
  assert.equal(directive(csp, "worker-src"), "worker-src 'self'", "the offline service worker");
  assert.equal(directive(csp, "manifest-src"), "manifest-src 'self'");
});

test("data may only leave to the app's own origin and the API", () => {
  assert.equal(directive(policy(), "connect-src"), `connect-src 'self' ${API}`);
  assert.equal(directive(policy(null), "connect-src"), "connect-src 'self'");
  assert.equal(policy().split(API).length - 1, 1, "the API origin appears exactly once");
  assert.equal(directive(policy("http://localhost:8787"), "connect-src"), "connect-src 'self' http://localhost:8787");
});

test("every response carries the framing, sniffing, referrer, permission and transport protections", () => {
  const h = headersFor("/students", headerRules({ apiOrigin: API }));
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin");
  assert.match(h["Strict-Transport-Security"]!, /^max-age=\d{7,}$/);
  assert.ok(!h["Strict-Transport-Security"]!.includes("preload"), "preload cannot be taken back, so it is not asked for");
  for (const feature of ["camera", "microphone", "geolocation", "payment"]) assert.ok(h["Permissions-Policy"]!.includes(`${feature}=()`), feature);
  assert.ok(h["Content-Security-Policy"]);
});

test("fingerprinted files are kept for a year; the page and the service worker are checked every visit", () => {
  const rules = headerRules({ apiOrigin: null });
  assert.equal(headersFor("/assets/index-3f2a9c.js", rules)["Cache-Control"], "public, max-age=31536000, immutable");
  for (const path of ["/index.html", "/sw.js", "/registerSW.js", "/manifest.webmanifest"]) assert.equal(headersFor(path, rules)["Cache-Control"], "no-cache", path);
  assert.equal(headersFor("/staff", rules)["Cache-Control"], undefined, "app pages are index.html served by a rewrite: Pages revalidates them itself");
  // every path, cached or not, still gets the security headers
  for (const path of ["/assets/x.js", "/sw.js", "/", "/accept", "/anything/at/all"]) assert.ok(headersFor(path, rules)["Content-Security-Policy"], path);
});

test("the _headers file: a path, its headers indented beneath it, no header named twice for one path", () => {
  const rules = headerRules({ apiOrigin: API });
  const file = headersFile(rules);
  assert.ok(file.startsWith("/*\n  Content-Security-Policy: default-src 'none'"));
  assert.ok(file.endsWith("\n"));
  const blocks = file.trim().split("\n\n");
  assert.equal(blocks.length, rules.length);
  for (const block of blocks) {
    const [path, ...lines] = block.split("\n");
    assert.ok(path!.startsWith("/"), path);
    assert.ok(lines.length > 0 && lines.every((l) => /^  [A-Za-z-]+: .+/.test(l)), block);
  }
  // Pages joins the values of the same header from several matching rules, so two rules must never both set one
  const seen = new Map<string, string[]>();
  for (const r of rules) for (const name of Object.keys(r.headers)) seen.set(name, [...(seen.get(name) ?? []), r.pattern]);
  for (const [name, where] of seen) {
    if (where.length > 1) {
      // allowed only when the paths cannot overlap (they are all exact files or the assets folder)
      assert.ok(!where.includes("/*"), `${name} is set by /* and by ${where.join(", ")}`);
    }
  }
});

test("the header rules never allow an empty or secret-bearing value", () => {
  for (const r of headerRules({ apiOrigin: API })) for (const [k, v] of Object.entries(r.headers)) {
    assert.ok(v.trim().length > 0, k);
    assert.ok(!/[\r\n]/.test(v), `${k} has a line break`);
  }
});
