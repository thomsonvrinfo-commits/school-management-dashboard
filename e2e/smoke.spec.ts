/**
 * What no other test here can show, because it needs a real browser:
 *  1. the production security policy does not block anything the app needs (no "Refused to ..." and no policy violation);
 *  2. a teacher can sign in and see her classes;
 *  3. a phone holding the current copy of her data is told "unchanged" (the cheaper sync), with the real IndexedDB.
 *
 * Needs the fictional dev school (npm run db:seed:dev): Ms. Chipo, password "schoolpulse-dev" unless DEV_PASSWORD says otherwise.
 */
import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "chipo@mavambo.example";
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.DEV_PASSWORD ?? "schoolpulse-dev";

/** Collects every security-policy violation and every console message about one, from before the page's own scripts run. */
async function watchForPolicyProblems(page: Page): Promise<() => Promise<string[]>> {
  const consoleProblems: string[] = [];
  page.on("console", (m) => {
    if (/Refused to|Content Security Policy|violates the following/i.test(m.text())) consoleProblems.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__violations.push(`${e.violatedDirective}: ${e.blockedURI}`));
  });
  return async () => [...consoleProblems, ...(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations))];
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your classes" })).toBeVisible();
}

test("the app and a deep link arrive with the security policy and the other protective headers", async ({ request }) => {
  for (const path of ["/", "/accept", "/classes/does-not-exist/attendance"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    expect(h["content-security-policy"], path).toContain("script-src 'self'");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["referrer-policy"], path).toBe("no-referrer");
  }
});

test("a teacher signs in and sees her classes, and the policy blocks nothing the app needs", async ({ page }) => {
  const problems = await watchForPolicyProblems(page);
  await signIn(page);
  await expect(page.getByText("Grade 7A").first()).toBeVisible();
  // let the first sync and the service worker settle, then look
  await page.waitForLoadState("networkidle");
  expect(await problems()).toEqual([]);
});

test("a phone that already holds the current copy is told 'unchanged' instead of downloading everything again", async ({ page }) => {
  await signIn(page);
  await page.waitForLoadState("networkidle");

  const isBootstrap = (url: string) => new URL(url).pathname === "/v1/sync/bootstrap";
  const quiet = page.waitForResponse(async (r) => isBootstrap(r.url()) && r.ok() && ((await r.json()) as { unchanged?: boolean }).unchanged === true);
  // What the app does when a teacher comes back to it: ask again straight away.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const answer = await quiet;

  expect(new URL(answer.url()).searchParams.get("since")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  const text = await answer.text();
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(["serverTime", "today", "unchanged", "version"]);
  expect(text.length).toBeLessThan(300);
});
