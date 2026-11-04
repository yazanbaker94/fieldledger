import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";

const screenshotDirectory = resolve("docs/screenshots");

function role(page: Page, name: "Worker" | "Foreman" | "Manager") {
  return page.getByRole("navigation", { name: "Demo role" })
    .getByRole("link", { name: new RegExp("^" + name) });
}

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
}

async function submitTimecard(page: Page, hours: number) {
  await page.getByLabel("Hours worked").fill(String(hours));
  await page.getByRole("button", { name: "Submit timecard" }).click();
  await expect(page.getByText("Timecard submitted for review.", { exact: true })).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  if (process.env.npm_lifecycle_event !== "screenshots") return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, name + ".png"),
    animations: "disabled",
    fullPage: false,
  });
}

test("screenshots and persistent budget changes across the worker, foreman, and manager views", async ({ browser, baseURL }) => {
  const mobile = devices["iPhone 13"];
  const context = await browser.newContext({
    viewport: { width: mobile.viewport.width, height: 844 },
    userAgent: mobile.userAgent,
    isMobile: true,
    hasTouch: true,
    baseURL,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
  await page.getByLabel("Hours worked").fill("8");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(mobile.viewport.width);
  await screenshot(page, "worker");
  await submitTimecard(page, 8);

  const desktop = await browser.newContext({
    storageState: await context.storageState(),
    viewport: { width: 1440, height: 810 },
    baseURL,
  });
  const reviewer = await desktop.newPage();
  reviewer.on("pageerror", error => errors.push(error.message));
  await reviewer.goto("/#foreman");
  await expect(reviewer.getByRole("heading", { name: "Review timecards" })).toBeVisible();
  await expect(reviewer.getByRole("button", { name: "Approve timecard" })).toBeVisible();
  await screenshot(reviewer, "foreman");
  await role(reviewer, "Manager").click();
  await expect(reviewer.locator("#approved-total")).toContainText("$9,700");
  await role(reviewer, "Foreman").click();
  await reviewer.getByRole("button", { name: "Approve timecard" }).click();
  await expect(reviewer.getByText("Timecard approved.", { exact: true })).toBeVisible();
  await role(reviewer, "Manager").click();
  await expect(reviewer.getByRole("heading", { name: "Labour budget" })).toBeVisible();
  await expect(reviewer.locator("#approved-total")).toContainText("$10,100");
  await expect(reviewer.getByText("$100 over budget", { exact: true })).toBeVisible();
  await reviewer.getByRole("button", { name: /View timecard for/ }).first().click();
  await expect(reviewer.getByRole("region", { name: "Cost details" }).getByText("$400", { exact: true })).toBeVisible();
  await reviewer.setViewportSize({ width: 1440, height: 1160 });
  await screenshot(reviewer, "manager");
  await reviewer.reload();
  await expect(reviewer.locator("#approved-total")).toContainText("$10,100");
  await reviewer.getByRole("button", { name: /View timecard for/ }).first().click();
  await expect(reviewer.getByRole("region", { name: "Cost details" }).getByText(/Lucas Martin/).first()).toBeVisible();
  expect(errors).toEqual([]);

  const freshVisitor = await browser.newPage({ baseURL });
  await freshVisitor.goto("/#manager");
  await expect(freshVisitor.locator("#approved-total")).toContainText("$9,700");
  await freshVisitor.close();
  await desktop.close();
  await context.close();
});

test("foreman returns a card, the worker corrects it, and reset restores the starting budget", async ({ page }) => {
  await enterDemo(page);
  await submitTimecard(page, 7);
  await role(page, "Foreman").click();
  await page.getByRole("button", { name: "Return with a note" }).click();
  await page.getByLabel("Correction note").fill("Please include the final hour spent on site.");
  await page.getByRole("button", { name: "Send back to worker" }).click();
  await expect(page.getByText("Timecard returned to the worker.", { exact: true })).toBeVisible();
  await role(page, "Worker").click();
  await expect(page.getByText("Please include the final hour spent on site.", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Correct and resubmit" }).click();
  await page.getByLabel("Hours worked").fill("8");
  await page.getByRole("button", { name: "Resubmit timecard" }).click();
  await role(page, "Foreman").click();
  await page.getByRole("button", { name: "Approve timecard" }).click();
  await expect(page.getByText("Timecard approved.", { exact: true })).toBeVisible();
  await role(page, "Manager").click();
  await expect(page.locator("#approved-total")).toContainText("$10,100");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Reset workspace" }).click();
  await role(page, "Manager").click();
  await expect(page.locator("#approved-total")).toContainText("$9,700");
});

test("key screens pass automated accessibility checks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();
  const scan = async () => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations).toEqual([]);
  };

  await scan();
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
  await scan();
  await submitTimecard(page, 8);
  await role(page, "Foreman").click();
  await expect(page.getByRole("heading", { name: "Review timecards" })).toBeVisible();
  await scan();
  await role(page, "Manager").click();
  await expect(page.getByRole("heading", { name: "Labour budget" })).toBeVisible();
  await scan();
});

test("a failed workspace request can be retried in the browser", async ({ page }) => {
  await page.route("**/api/workspace", route => route.abort(), { times: 1 });
  await page.goto("/#worker");
  await expect(page.getByRole("heading", { name: "Workspace unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
});

test("a manager returning to an existing tab sees the approval made in another tab", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 8);
  const manager = await context.newPage();
  await manager.goto("/#manager");
  await expect(manager.locator("#approved-total")).toContainText("$9,700");

  await role(page, "Foreman").click();
  await page.getByRole("button", { name: "Approve timecard" }).click();
  await expect(page.getByText("Timecard approved.", { exact: true })).toBeVisible();
  await manager.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(manager.locator("#approved-total")).toContainText("$10,100");
});

test("leaving and re-entering the demo during first load keeps a single workspace request", async ({ page }) => {
  let count = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/workspace", async route => {
    count += 1;
    await wait;
    await route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect.poll(() => count).toBe(1);
  await page.getByRole("link", { name: /^FieldLedger/ }).click();
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page.getByText("Opening your workspace…", { exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
  expect(count).toBe(1);
});
