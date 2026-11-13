import { defineConfig, devices } from "@playwright/test";

// Real browser gate (§4). Runs against the same built app + fresh DB as
// ./e2e.sh (E2E_BASE, default :4591). Node fetch specs stay for cheap API
// checks; this suite proves the UI renders and behaves.
const baseURL = process.env["E2E_BASE"] ?? "http://127.0.0.1:4591";

export default defineConfig({
  testDir: "./e2e-browser",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "/tmp/morrow-playwright",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
