/**
 * End-to-end checks in a real browser (Chromium, phone-sized), against the BUILT app served with the production
 * security headers and a real API on a real database. See docs/RUNBOOK.md ("The browser check") for how to start them;
 * the CI workflow does the same steps.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "phone", use: { ...devices["Pixel 7"] } }],
});
