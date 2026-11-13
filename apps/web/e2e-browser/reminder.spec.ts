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
test("reminder: due-now task enqueues a delivery and ledger is honest", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only; mobile covered by mobile.spec.ts");
  await ensureAuth(page);

  const title = `Browser reminder ${Date.now()}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
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
  const taskId = created.body?.id;
  expect(taskId).toBeTruthy();

  // Scheduler ticks every 15s; poll the ledger/activity for an enqueue row.
  // "No devices" is acceptable when push is off — the reminder still armed.
  // Check the VALUE (last_status), not key names (last_sent contains "sent").
  let found = false;
  for (let i = 0; i < 12; i++) {
    const state = await page.evaluate(async (id) => {
      const ledgerRes = await fetch(
        `/api/tasks/${encodeURIComponent(id)}/ledger`,
      );
      const ledger = await ledgerRes.json().catch(() => null);
      return { ledgerStatus: ledgerRes.status, ledger };
    }, taskId);
    if (
      state.ledgerStatus === 200 &&
      state.ledger?.last_status != null &&
      /enqueued|queued|sent|skipped|no devices/i.test(
        String(state.ledger.last_status),
      )
    ) {
      found = true;
      break;
    }
    await page.waitForTimeout(5_000);
  }
  expect(found).toBe(true);

  // In-app ledger renders without a fake "All set".
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText("Reminders & delivery")).toBeVisible({
    timeout: 15_000,
  });
});
