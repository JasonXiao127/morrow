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
test("core: login → Today → task renders → edit → complete", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only; mobile covered by mobile.spec.ts");
  await ensureAuth(page);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

  const title = `Browser core ${Date.now()}`;
  const dueAt = new Date().toISOString();
  const created = await page.evaluate(
    async ({ t, due }) => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: t, dueAt: due }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { t: title, due: dueAt },
  );
  expect(created.status).toBe(201);
  const taskId = created.body?.id ?? created.body?.task?.id;
  expect(taskId).toBeTruthy();

  await page.goto("/today");
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });

  // Open detail and edit via UI.
  await page.getByText(title).first().click();
  await expect(page.getByText("Reminders & delivery")).toBeVisible({
    timeout: 15_000,
  });
  const editButton = page.getByRole("button", { name: /edit task/i });
  await expect(editButton).toBeVisible();
  await editButton.click();
  const titleInput = page.locator("#task-title");
  await expect(titleInput).toBeVisible();
  const edited = `${title} (edited)`;
  await titleInput.fill(edited);
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByText("(edited)").first()).toBeVisible({
    timeout: 15_000,
  });

  // Complete via UI.
  const doneButton = page.getByRole("button", { name: /mark done|completed/i });
  await expect(doneButton.first()).toBeVisible();
  await doneButton.first().click();
  // Completed state shows "Completed" (button disabled or label change).
  await expect(
    page.getByRole("button", { name: /completed/i }).first(),
  ).toBeVisible({ timeout: 15_000 });
});
