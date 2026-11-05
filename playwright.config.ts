// Playwright config for the browser happy path (tests/e2e). BASE points it at a deployed Worker;
// without BASE it targets the local wrangler dev server that scripts/test-browser.sh starts.
import process from "node:process";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE ?? "http://localhost:8787",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
