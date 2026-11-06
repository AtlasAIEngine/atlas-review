import { test, expect } from "@playwright/test";

const API_BASE = process.env.PW_API_BASE_URL || "http://127.0.0.1:3000/api";

test("github device flow connect (manual completion)", async ({ page }) => {
  test.setTimeout(180_000);

  page.on("console", (msg) => {
    console.log(`[console:${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.log(`[pageerror] ${err.message}`);
  });

  await page.goto("http://127.0.0.1:5173");

  const openAppButton = page.getByRole("button", { name: /Open App/i });
  if (await openAppButton.isVisible().catch(() => false)) {
    await openAppButton.click();
  }

  // Open GitHub import modal from home page
  await page.getByRole("button", { name: "GitHub", exact: true }).click();

  const connectButton = page.getByRole("button", { name: /Connect GitHub/i }).first();
  const hasConnectButton = await connectButton.waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  let response;
  if (hasConnectButton) {
    await expect(connectButton).toBeEnabled();
    [response] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/api/github/connect"),
        { timeout: 15_000 }
      ),
      connectButton.click(),
    ]);
  } else {
    await expect(page.getByText(/Authorize GitHub|Authorization Required/i)).toHaveCount(0);
    await page.keyboard.press("Escape");
    const accountSettingsButton = page.getByTitle(/Open GitHub settings/i);
    await expect(accountSettingsButton).toBeVisible();
    await accountSettingsButton.click();
    await expect(page.getByText("GitHub Accounts")).toBeVisible();
    response = await page.request.get(`${API_BASE}/github/connect?force=new-account`);
  }

  const connectData = await response.json();
  console.log("[GitHub E2E] connect response:", connectData);
  expect(connectData.step).toBe("device");
  expect(connectData).toEqual(expect.objectContaining({
    success: true,
    url: expect.any(String),
    userCode: expect.any(String),
    verificationUri: expect.any(String),
  }));

  if (connectData.userCode) {
    console.log("[GitHub E2E] device code:", connectData.userCode);
  }

  const verifyUrl =
    connectData.verificationUriComplete ||
    connectData.verificationUri ||
    connectData.url;
  if (verifyUrl) {
    const authPage = await page.context().newPage();
    try {
      await authPage.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (err) {
      console.log("[GitHub E2E] auth page navigation failed, please complete manually:", verifyUrl);
    }
  }

  // Poll for connection completion (manual auth in browser)
  const deadline = Date.now() + 120_000;
  let finalStatus = connectData;
  while (Date.now() < deadline) {
    const statusResp = await page.request.get(
      `${API_BASE}/github/connect`
    );
    finalStatus = await statusResp.json();
    console.log("[GitHub E2E] connect status:", finalStatus);
    if (finalStatus.step === "connected") break;
    await page.waitForTimeout(3000);
  }

  expect(finalStatus.step).toBe("connected");
});
