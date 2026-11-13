import { expect, test } from "@playwright/test";

const SETUP_TOKEN = process.env["SETUP_TOKEN"] ?? "e2e-refine-123";
const PASSWORD = process.env["E2E_PASSWORD"] ?? "e2e-password-12345";

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

async function assistantStatus(page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/assistant/status");
    const body = await res.json().catch(() => null);
    return body?.status ?? null;
  });
}

// M4 browser assertions (§4): with no sidecar the assistant is honestly off.
test("assistant: AI-off is honest, no surprises", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only; mobile covered by mobile.spec.ts");
  await ensureAuth(page);

  const status = await page.evaluate(async () => {
    const res = await fetch("/api/bootstrap");
    const body = await res.json().catch(() => null);
    return body?.agent ?? null;
  });
  // This test runs against the default AI-off deployment. When a harness
  // sidecar is present, the ready-path test below covers the panel instead.
  test.skip(Boolean(status?.enabled), "AI is configured; see the ready-path test");
  expect(status).toBeTruthy();
  expect(status.enabled).toBe(false);

  await page.goto("/settings");
  // Settings → AI section renders (exact copy varies; assert the section).
  await expect(page.getByText(/AI|Assistant/i).first()).toBeVisible({
    timeout: 15_000,
  });
});

// This is the regression gate for the panel's conversation bootstrap. A
// sidecar is not required for the AI-off test above, but it is required here.
test("assistant: ready panel enables the composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only; mobile covered by mobile.spec.ts");
  await ensureAuth(page);

  const status = await assistantStatus(page);
  test.skip(
    !status || status.status !== "ready" || !status.available,
    "requires a ready OpenCode sidecar",
  );

  await page.goto("/assistant");
  const composer = page.getByRole("textbox", { name: "Ask the assistant" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await expect(composer).toHaveAttribute(
    "placeholder",
    /Ask Morrow to plan, triage, or change one thing/,
  );
});
