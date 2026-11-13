import { expect, test } from "@playwright/test";

const SETUP_TOKEN = process.env["SETUP_TOKEN"] ?? "e2e-refine-123";
const PASSWORD = process.env["E2E_PASSWORD"] ?? "e2e-password-12345";

test.use({ viewport: { width: 390, height: 844 } });

async function ensureAuth(page) {
  // Ensure the owner exists via API (idempotent: 201 fresh, 409 already).
  await page.goto("/setup");
  await page.evaluate(
    async ({ token, pwd }) => {
      try {
        await fetch("/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password: pwd, timezone: "UTC" }),
        });
      } catch {
        // Network errors surface below via UI assertions.
      }
    },
    { token: SETUP_TOKEN, pwd: PASSWORD },
  );
  // Now sign in via UI (real browser coverage of the login flow).
  await page.goto("/login");
  const loginPassword = page.locator("#login-password");
  const todayHeading = page.getByRole("heading", { level: 1, name: "Today" });
  await expect(loginPassword.or(todayHeading)).toBeVisible({ timeout: 15_000 });
  if (await loginPassword.isVisible().catch(() => false)) {
    await loginPassword.fill(PASSWORD);
    await page.keyboard.press("Enter");
    await expect(todayHeading).toBeVisible({ timeout: 15_000 });
  }
}
test("mobile 390px: tabs + FAB + keyboard path", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile tab bar is md:hidden on desktop");
  await ensureAuth(page);

  // Bottom tabs (Today/Upcoming/Lists/Settings) + capture FAB.
  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  await expect(primaryNav.getByRole("link", { name: "Today" })).toBeVisible();
  await expect(primaryNav.getByRole("link", { name: "Upcoming" })).toBeVisible();
  await expect(primaryNav.getByRole("link", { name: "Lists" })).toBeVisible();
  await expect(primaryNav.getByRole("link", { name: "Settings" })).toBeVisible();
  const fab = page.getByRole("button", { name: /add a reminder/i });
  await expect(fab).toBeVisible();

  // Keyboard-only: Tab reaches the FAB and Enter opens capture.
  await fab.focus();
  await expect(fab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/capture it, sort it later/i).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
});
