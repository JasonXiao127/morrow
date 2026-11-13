import { expect, test } from "@playwright/test";

const SETUP_TOKEN = process.env["SETUP_TOKEN"] ?? "e2e-refine-123";
const PASSWORD = process.env["E2E_PASSWORD"] ?? "e2e-password-12345";

async function ensureAuth(page) {
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
        // The UI assertions below surface a failed boot.
      }
    },
    { token: SETUP_TOKEN, pwd: PASSWORD },
  );
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

test("product: tag, subtask, attachment, calendar, integrations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only; mobile covered by mobile.spec.ts");
  await ensureAuth(page);

  const title = `Product browser ${Date.now()}`;
  const tagName = `e2e-${Date.now()}`;
  const created = await page.evaluate(
    async ({ t }) => {
      const task = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: t,
          dueDate: new Date().toISOString().slice(0, 10),
          allDay: true,
        }),
      });
      return await task.json();
    },
    { t: title },
  );

  await page.goto(`/tasks/${created.id}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const tagsRegion = page.getByRole("region", { name: "Tags" });
  await tagsRegion.getByRole("button", { name: "New tag" }).click();
  await tagsRegion.getByPlaceholder("Tag name").fill(tagName);
  await tagsRegion.getByRole("button", { name: "Add" }).click();
  await expect(tagsRegion.getByText(tagName)).toBeVisible({ timeout: 15_000 });

  const subtaskTitle = `Subtask ${Date.now()}`;
  await page.getByPlaceholder("Add a subtask").fill(subtaskTitle);
  await page.getByPlaceholder("Add a subtask").press("Enter");
  await expect(page.getByText(subtaskTitle)).toBeVisible({ timeout: 15_000 });

  await page.setInputFiles('input[type="file"]', {
    name: "e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("e2e attachment"),
  });
  await expect(
    page.getByRole("link", { name: "e2e.txt", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  await page.goto("/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await expect(page.getByText(title).first()).toBeVisible();

  await page.goto("/settings?section=integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capture & CalDAV tokens" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Calendar (ICS / CalDAV)" }),
  ).toBeVisible();
});
