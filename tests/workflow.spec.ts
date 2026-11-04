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

test("screenshots of mobile correction and reset after approval", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  await submitTimecard(page, 7);
  await role(page, "Foreman").click();
  await page.getByRole("button", { name: "Return with a note" }).click();
  await page.getByLabel("Correction note").fill("Please include the final hour spent on site.");
  await page.getByRole("button", { name: "Send back to worker" }).click();
  await expect(page.getByText("Timecard returned to the worker.", { exact: true })).toBeVisible();
  await role(page, "Worker").click();
  const actionNeeded = page.getByRole("complementary", { name: "Action needed" });
  await expect(actionNeeded).toContainText("Please include the final hour spent on site.");
  const correction = actionNeeded.getByRole("button", { name: "Correct and resubmit" });
  await expect(correction).toBeInViewport();
  await screenshot(page, "worker-correction");
  await correction.click();
  await page.getByLabel("Hours worked").fill("8");
  await page.getByRole("button", { name: "Resubmit timecard" }).click();
  await expect(page.getByText("Timecard resubmitted for review.", { exact: true })).toBeVisible();
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

test("screenshots of the backdated mobile handoff and approved correction history", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  const workDate = page.getByLabel("Work date");
  const today = await workDate.inputValue();
  const yesterday = new Date(Date.parse(today + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);

  await submitTimecard(page, 6);
  await workDate.fill(yesterday);
  await submitTimecard(page, 7);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  const review = page.getByRole("region", { name: "Timecard review" });
  await expect(review.getByText("7 hrs", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Return with a note" }).click();
  await page.getByLabel("Correction note").fill("Please include the final hour spent on site.");
  await page.getByRole("button", { name: "Send back to worker" }).click();
  await page.getByRole("button", { name: "Go to worker" }).click();
  await expect(page.getByRole("heading", { name: "Correct timecard" })).toBeInViewport();
  await expect(page.getByText("Please include the final hour spent on site.", { exact: true }).first()).toBeInViewport();
  await expect(workDate).toHaveValue(yesterday);
  await page.getByLabel("Hours worked").fill("8");
  await page.getByRole("button", { name: "Resubmit timecard" }).click();
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await expect(review.getByText("8 hrs", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Approve timecard" }).click();
  await page.getByRole("button", { name: "Go to manager" }).click();
  await expect(page.locator("#approved-total")).toContainText("$10,100");
  const details = page.getByRole("region", { name: "Cost details" });
  await expect(details).toContainText("$50/hr");
  await expect(details).toContainText("$400");
  await expect(details).toContainText("Please include the final hour spent on site.");
  await expect(details).toContainText(/Previous entry\s*:?\s*7 hrs/);
  await expect(details).toContainText(/Updated entry\s*:?\s*8 hrs/);
  if (process.env.npm_lifecycle_event === "screenshots") {
    await page.setViewportSize({ width: 1440, height: 1160 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot(page, "manager");
  }
});

test("returning from the welcome screen reloads changes made in another tab", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 8);
  const viewer = await context.newPage();
  await viewer.goto("/#manager");
  await expect(viewer.locator("#approved-total")).toContainText("$9,700");
  await viewer.getByRole("link", { name: /^FieldLedger/ }).click();
  await expect(viewer.getByRole("button", { name: "Try the demo" })).toBeVisible();

  await role(page, "Foreman").click();
  await page.getByRole("button", { name: "Approve timecard" }).click();
  await expect(page.getByText("Timecard approved.", { exact: true })).toBeVisible();
  await viewer.evaluate(() => window.dispatchEvent(new Event("focus")));
  await viewer.getByRole("button", { name: "Try the demo" }).click();
  await role(viewer, "Manager").click();
  await expect(viewer.locator("#approved-total")).toContainText("$10,100");
});

test("cancelling a return note restores keyboard focus", async ({ page }) => {
  await enterDemo(page);
  await submitTimecard(page, 8);
  await role(page, "Foreman").click();
  const openReturn = page.getByRole("button", { name: "Return with a note" });
  await openReturn.press("Enter");
  await expect(page.getByLabel("Correction note")).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
  await expect(openReturn).toBeFocused();
});

test("a saved submission is recovered on reload even from an old correction link", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 6);
  const initialResponse = await context.request.get("/api/workspace");
  const initial = await initialResponse.json() as { timecards: { id: string; hours: number; status: string }[] };
  const earlier = initial.timecards.find(card => card.status === "pending" && card.hours === 6);
  expect(earlier).toBeDefined();
  let writeStatus = 0;
  await page.route("**/api/timecards", async route => {
    const saved = await route.fetch();
    writeStatus = saved.status();
    await route.abort();
  }, { times: 1 });

  await page.getByLabel("Hours worked").fill("8");
  await page.getByRole("button", { name: "Submit timecard" }).click();
  await expect(page.getByRole("alert")).toContainText("The request didn’t finish");
  expect(writeStatus).toBe(200);
  await page.evaluate(id => history.replaceState(null, "", "#worker?card=" + id), earlier!.id);
  await page.reload();
  await expect(page.getByText("Recovered your submitted timecard.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Linked timecard" })).toContainText("6 hrs");
  await expect(page.getByRole("button", { name: "Submit timecard" })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await expect(page.getByRole("region", { name: "Timecard review" })).toContainText("8 hrs");

  const response = await context.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  const workspace = await response.json() as { project: { pendingCents: number }; timecards: { status: string }[] };
  expect(workspace.project.pendingCents).toBe(70_000);
  expect(workspace.timecards.filter(card => card.status === "pending")).toHaveLength(2);
});

test("a manual retry after switching roles reuses the submission ID if the lookup is unavailable", async ({ page }) => {
  await enterDemo(page);
  let originalRequestId: string | undefined;
  await page.route("**/api/timecards", async route => {
    originalRequestId = route.request().postDataJSON().requestId;
    await route.fetch();
    await route.abort();
  }, { times: 1 });
  await page.route("**/api/timecards/submissions/*", route => route.fulfill({
    status: 503,
    json: { message: "Lookup unavailable." },
  }));

  await page.getByRole("button", { name: "Submit timecard" }).click();
  await expect(page.getByRole("alert")).toContainText("The request didn’t finish");
  await role(page, "Foreman").click();
  await role(page, "Worker").click();
  const retry = page.waitForRequest(request => request.url().endsWith("/api/timecards") && request.method() === "POST");
  await submitTimecard(page, 8);
  expect(originalRequestId).toBeTruthy();
  expect((await retry).postDataJSON().requestId).toBe(originalRequestId);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await expect(page.getByRole("region", { name: "Review queue" })).toContainText("1 pending");
});

test("two tabs opening the demo for the first time share a single browser workspace", async ({ page, context }) => {
  const other = await context.newPage();
  const ids: string[] = [];
  let count = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await context.route("**/api/workspace", async route => {
    const position = count++;
    if (position === 0) await hold;
    const response = await route.fetch();
    const body = await response.json() as { workspaceId: string };
    ids[position] = body.workspaceId;
    await route.fulfill({ response });
  });

  await page.goto("/#worker");
  await expect.poll(() => count).toBe(1);
  await other.goto("/#manager");
  try {
    await expect.poll(async () => other.evaluate(async () => (await navigator.locks.query()).pending?.length))
      .toBeGreaterThan(0);
    expect(count).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole("heading", { name: "Log a timecard" })).toBeVisible();
  await expect(other.locator("#approved-total")).toContainText("$9,700");
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBe(ids[0]);
});

async function returnCurrentTimecard(page: Page, reason: string) {
  await page.getByRole("button", { name: "Return with a note" }).click();
  await page.getByLabel("Correction note").fill(reason);
  await page.getByRole("button", { name: "Send back to worker" }).click();
  await expect(page.getByText("Timecard returned to the worker.", { exact: true })).toBeVisible();
}

async function refreshFromAnotherTab(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test("linked and manually selected foreman cards stay exact through updates in another tab", async ({ page, context }) => {
  await enterDemo(page);
  const workDate = page.getByLabel("Work date");
  const today = await workDate.inputValue();
  const yesterday = new Date(Date.parse(today + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  await submitTimecard(page, 6);
  await workDate.fill(yesterday);
  await submitTimecard(page, 7);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  const details = page.getByRole("region", { name: "Timecard review" });
  await expect(details.getByText("7 hrs", { exact: true })).toBeVisible();
  const linkedUrl = page.url();

  const reviewer = await context.newPage();
  await reviewer.goto(linkedUrl);
  await reviewer.getByRole("button", { name: "Approve timecard" }).click();
  await expect(reviewer.getByText("Timecard approved.", { exact: true })).toBeVisible();
  await refreshFromAnotherTab(page);
  await expect(details).toContainText("This timecard is no longer pending.");
  await expect(details.getByText("7 hrs", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Approve timecard" })).toHaveCount(0);
  expect(page.url()).toBe(linkedUrl);

  await role(page, "Foreman").click();
  await page.getByRole("region", { name: "Review queue" }).getByRole("button", { name: /View timecard for.*6 hrs/ }).click();
  await expect(details.getByText("6 hrs", { exact: true })).toBeVisible();
  await reviewer.getByRole("button", { name: "Reset demo" }).click();
  await reviewer.getByRole("button", { name: "Reset workspace" }).click();
  await expect(reviewer.getByText("A fresh workspace is ready.", { exact: true })).toBeVisible();
  await role(reviewer, "Worker").click();
  await submitTimecard(reviewer, 5);
  await refreshFromAnotherTab(page);
  await expect(details.getByRole("heading", { name: "Selected timecard unavailable" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Approve timecard" })).toHaveCount(0);
  await page.getByRole("region", { name: "Review queue" }).getByRole("button", { name: /View timecard for.*5 hrs/ }).click();
  await expect(details.getByText("5 hrs", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Approve timecard" })).toBeEnabled();
});

test("a lost correction response reconciles the same card after focus refresh", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 7);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await returnCurrentTimecard(page, "Please include the final hour spent on site.");
  await page.getByRole("button", { name: "Go to worker" }).click();
  await page.getByLabel("Hours worked").fill("8");
  let responseStatus = 0;
  let correctionRequestId: string | null = null;
  await page.route("**/api/timecards/*/resubmit", async route => {
    correctionRequestId = await route.request().headerValue("Idempotency-Key");
    const saved = await route.fetch();
    responseStatus = saved.status();
    await route.abort();
  }, { times: 1 });
  await page.getByRole("button", { name: "Resubmit timecard" }).click();
  await expect.poll(() => responseStatus).toBe(200);
  await expect(page.getByRole("alert")).toContainText(/try again|confirm|interrupted/i);
  expect(correctionRequestId).toBeTruthy();
  const oldClientStorage = await page.evaluate(() => sessionStorage.getItem("fieldledger.submission-retries.v1"));
  expect(oldClientStorage ?? "").not.toContain(correctionRequestId!);
  await refreshFromAnotherTab(page);
  await expect(page.getByText("Recovered your resubmitted timecard.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await expect(page.getByRole("region", { name: "Timecard review" })).toContainText("8 hrs");

  const response = await context.request.get("/api/workspace");
  const workspace = await response.json() as { project: { pendingCents: number }; timecards: { status: string }[] };
  expect(workspace.project.pendingCents).toBe(40_000);
  expect(workspace.timecards.filter(card => card.status === "pending")).toHaveLength(1);
});

test("a correction draft requires explicit review after another tab starts a newer cycle", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 7);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await returnCurrentTimecard(page, "Please check the shift.");
  await page.getByRole("button", { name: "Go to worker" }).click();
  await page.getByLabel("Hours worked").fill("8");

  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByLabel("Hours worked").fill("9");
  await other.getByRole("button", { name: "Resubmit timecard" }).click();
  await other.getByRole("button", { name: "Go to foreman" }).click();
  await returnCurrentTimecard(other, "Confirm the nine hours against your shift log.");
  await refreshFromAnotherTab(page);

  await expect(page.getByText("Timecard changed while you were editing.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Hours worked")).toHaveValue("8");
  await expect(page.getByRole("button", { name: "Resubmit timecard" })).toBeDisabled();
  await page.getByRole("button", { name: "Review latest timecard" }).click();
  await expect(page.getByLabel("Hours worked")).toHaveValue("9");
  await expect(page.getByText("Confirm the nine hours against your shift log.", { exact: true }).first()).toBeVisible();
});

test("a foreman note stays tied to the version reviewed when it was drafted", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 7);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await page.getByRole("button", { name: "Return with a note" }).click();
  const note = page.getByLabel("Correction note");
  await note.fill("Original draft for the seven-hour entry.");

  const other = await context.newPage();
  await other.goto(page.url());
  await returnCurrentTimecard(other, "Please check the shift.");
  await other.getByRole("button", { name: "Go to worker" }).click();
  await other.getByLabel("Hours worked").fill("9");
  await other.getByRole("button", { name: "Resubmit timecard" }).click();
  await expect(other.getByText("Timecard resubmitted for review.", { exact: true })).toBeVisible();
  await refreshFromAnotherTab(page);

  await expect(page.getByText("Timecard changed while you were writing this note.", { exact: true })).toBeVisible();
  await expect(note).toHaveValue("Original draft for the seven-hour entry.");
  await expect(page.getByRole("button", { name: "Send back to worker" })).toBeDisabled();
  await page.getByRole("button", { name: "Review latest timecard" }).click();
  await expect(page.getByRole("region", { name: "Timecard review" }).getByText("9 hrs", { exact: true })).toBeVisible();
});

test("desktop keyboard review offers a direct path to and from details and restores reset focus", async ({ page }) => {
  await enterDemo(page);
  await submitTimecard(page, 8);
  await role(page, "Foreman").click();
  const queue = page.getByRole("region", { name: "Review queue" });
  const pending = queue.getByRole("button", { name: /View timecard for/ }).first();
  const review = page.getByRole("region", { name: "Timecard review" });
  await pending.press("Enter");
  await expect(review).toBeFocused();
  await review.getByRole("button", { name: "Back to review queue" }).press("Enter");
  await expect(pending).toBeFocused();

  await role(page, "Manager").click();
  const ledger = page.getByRole("region", { name: "Timecard ledger" });
  const entry = ledger.getByRole("button", { name: /View timecard for/ }).first();
  const details = page.getByRole("region", { name: "Cost details" });
  await entry.press("Enter");
  await expect(details).toBeFocused();
  await details.getByRole("button", { name: "Back to timecard ledger" }).press("Enter");
  await expect(entry).toBeFocused();

  const reset = page.getByRole("button", { name: "Reset demo" });
  await reset.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(reset).toBeFocused();
});

test("an open foreman review keeps its card and requires review of revised hours", async ({ page, context }) => {
  await enterDemo(page);
  await submitTimecard(page, 7);
  await role(page, "Foreman").click();
  const review = page.getByRole("region", { name: "Timecard review" });
  const approve = review.getByRole("button", { name: "Approve timecard" });
  const queue = page.getByRole("region", { name: "Review queue" });
  await expect(review.getByText("7 hrs", { exact: true })).toBeVisible();
  const originalId = await queue.getByRole("button", { name: /View timecard for.*7 hrs/ }).getAttribute("data-card-id");

  const other = await context.newPage();
  await other.goto("/#worker");
  await submitTimecard(other, 5);
  await refreshFromAnotherTab(page);
  await expect(queue.getByRole("button", { name: /View timecard for.*5 hrs/ })).toBeVisible();
  await expect(review.getByText("7 hrs", { exact: true })).toBeVisible();
  await approve.focus();

  await other.goto(`/#foreman?card=${originalId}`);
  await returnCurrentTimecard(other, "Include one more hour.");
  await other.getByRole("button", { name: "Go to worker" }).click();
  await other.getByLabel("Hours worked").fill("8");
  await other.getByRole("button", { name: "Resubmit timecard" }).click();
  await expect(other.getByText("Timecard resubmitted for review.", { exact: true })).toBeVisible();
  await refreshFromAnotherTab(page);

  await expect(review.getByText("8 hrs", { exact: true })).toBeVisible();
  await expect(approve).toBeDisabled();
  await review.getByRole("button", { name: "Review latest timecard" }).click();
  await approve.click();
  await page.getByRole("button", { name: "Go to manager" }).click();
  await expect(page.locator("#approved-total")).toHaveText("$10,100");
  await expect(page).toHaveURL(new RegExp(`card=${originalId}$`));
});

test("the narrow budget fits cents and links directly to the approved timecard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 750 });
  await enterDemo(page);
  await submitTimecard(page, 8.01);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await page.getByRole("button", { name: "Approve timecard" }).click();
  await page.getByRole("button", { name: "Go to manager" }).click();

  const approved = page.locator("#approved-total");
  await expect(approved).toHaveText("$10,100.50");
  expect(await approved.evaluate((amount) => amount.scrollWidth <= amount.clientWidth)).toBe(true);
  const jump = page.getByRole("button", { name: "View approved timecard" });
  await expect(jump).toBeInViewport();
  await jump.press("Enter");
  const detail = page.getByRole("region", { name: "Cost details" });
  await expect(detail).toBeFocused();
  await expect(detail.getByText("8.01 hrs × $50/hr", { exact: true })).toBeInViewport();
});

test("a stalled submission times out across roles and unlocks the workspace", async ({ page }) => {
  await page.clock.install();
  await enterDemo(page);
  await page.route("**/api/timecards", () => {});
  await page.getByRole("button", { name: "Submit timecard" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await role(page, "Manager").click();
  const reset = page.getByRole("button", { name: "Reset demo" });
  await expect(reset).toBeDisabled();
  await page.clock.fastForward(10_001);
  await expect(page.getByRole("alert")).toContainText("The connection timed out.");
  await expect(reset).toBeEnabled();
  await expect(page.locator("#approved-total")).toHaveText("$9,700");
});

test("lost approval and reset responses reconcile and keyboard reset restores focus", async ({ page }) => {
  await enterDemo(page);
  await submitTimecard(page, 8);
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await page.route("**/api/timecards/*/decision", async (route) => {
    await route.fetch();
    await route.abort();
  }, { times: 1 });
  await page.getByRole("button", { name: "Approve timecard" }).click();
  await page.getByRole("button", { name: "Go to manager" }).click();
  await expect(page.locator("#approved-total")).toHaveText("$10,100");

  await page.route("**/api/reset", async (route) => {
    await route.fetch();
    await route.abort();
  }, { times: 1 });
  const reset = page.getByRole("button", { name: "Reset demo" });
  await reset.press("Enter");
  await page.getByRole("button", { name: "Reset workspace" }).press("Enter");
  await expect(page.getByText("A fresh workspace is ready.", { exact: true })).toBeVisible();
  await expect(reset).toBeFocused();
  await expect(page.locator("#approved-total")).toHaveText("$9,700");
});
