import { expect, test } from "@playwright/test";

// Runs only through e2e.sh's pre-setup gate (MORROW_FRESH_E2E=1). The normal
// suite runs after the owner exists, where this scenario cannot be reproduced.
test.describe("first run", () => {
  test.skip(
    process.env["MORROW_FRESH_E2E"] !== "1",
    "fresh-install gate; run via e2e.sh",
  );

  test("a zero-user instance opens setup, not login or session-expired", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop-only gate");

    const status = await page.request.get("/api/setup/status");
    expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({
      setupRequired: true,
      tokenRequired: false,
    });

    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(
      page.getByRole("heading", { name: "Make this place yours." }),
    ).toBeVisible();
    // Open first run: no token archaeology, just the owner account.
    await expect(page.locator("#setup-password")).toBeVisible();
    await expect(page.locator("#setup-token")).toHaveCount(0);

    // /login must not strand a first-run visitor either.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/setup$/);
  });
});
