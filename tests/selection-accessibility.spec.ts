import { expect, test, type Page } from "@playwright/test";

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function submit(page: Page, hours: string) {
  await page.getByLabel("Hours worked").fill(hours);
  await button(page, "Submit timecard").click();
  await expect(button(page, "Go to foreman")).toBeVisible();
}

test("Foreman and Manager keep the selected timecard in the URL and through reload", async ({ page }) => {
  await page.goto("/#worker");
  await submit(page, "3");
  await submit(page, "8");
  await page.getByRole("link", { name: /^Foreman/ }).click();

  const queue = page.getByRole("region", { name: "Review queue" });
  const review = page.getByRole("region", { name: "Timecard review" });
  const newer = queue.getByRole("button", { name: /View timecard for.*8 hrs/ });
  const older = queue.getByRole("button", { name: /View timecard for.*3 hrs/ });
  const newerId = await newer.getAttribute("data-card-id");
  const olderId = await older.getAttribute("data-card-id");
  await expect(page).toHaveURL(new RegExp(`#foreman\\?card=${newerId}$`));
  await older.press("Enter");
  await expect(review).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#foreman\\?card=${olderId}$`));
  await page.reload();
  await expect(review.getByText("3 hrs", { exact: true })).toBeVisible();
  await button(page, "Approve timecard").click();
  await button(page, "Go to manager").click();
  await expect(page.locator("#approved-total")).toHaveText("$9,850");

  const ledger = page.getByRole("region", { name: "Timecard ledger" });
  const details = page.getByRole("region", { name: "Cost details" });
  const archived = ledger.getByRole("button", { name: /View timecard for.*8 hrs/ }).first();
  const archivedId = await archived.getAttribute("data-card-id");
  await archived.press("Enter");
  await expect(details).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#manager\\?card=${archivedId}$`));
  await page.reload();
  await expect(details.getByText("8 hrs", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#manager\\?card=${olderId}$`));
  await expect(details.getByText("3 hrs", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 750 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect.poll(() => ledger.locator(".card-row").evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 1))).toBe(true);
  await expect(page.getByRole("link", { name: "Manager" })).toBeInViewport();
  await expect(page.getByText("98.5% of labour budget used")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("a stale return draft focuses the review action on cancel and rejects invisible notes", async ({ page, context }) => {
  await page.goto("/#foreman");
  const review = page.getByRole("region", { name: "Timecard review" });
  await expect(review.getByText("No timecard selected")).toBeVisible();

  const other = await context.newPage();
  await other.goto("/#worker");
  await submit(other, "7");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = page.getByRole("region", { name: "Review queue" }).getByRole("button", { name: /View timecard for.*7 hrs/ });
  await expect(row).toBeVisible();
  await expect(review.getByText("No timecard selected")).toBeVisible();
  await row.click();
  await button(page, "Return with a note").click();
  await page.getByLabel("Correction note").fill("\u200b\u200d\ufe0f");
  await expect(button(page, "Send back to worker")).toBeDisabled();
  await expect(page.getByText("Include a visible correction note.")).toBeVisible();
  await page.getByLabel("Correction note").fill("Check the shift start.");
  await expect(button(page, "Send back to worker")).toBeEnabled();

  await button(other, "Go to foreman").click();
  await button(other, "Return with a note").click();
  await other.getByLabel("Correction note").fill("Please check the recorded hours.");
  await button(other, "Send back to worker").click();
  await button(other, "Go to worker").click();
  await other.getByLabel("Hours worked").fill("8");
  await button(other, "Resubmit timecard").click();
  await expect(button(other, "Go to foreman")).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Timecard changed while you were writing this note.")).toBeVisible();
  await button(page, "Cancel").press("Enter");
  await expect(button(page, "Review latest timecard")).toBeFocused();
  await expect(button(page, "Approve timecard")).toBeDisabled();
});

test("role and home links preserve modified clicks", async ({ page, context }) => {
  await page.goto("/#worker");
  await expect(button(page, "Submit timecard")).toBeVisible();

  const foremanTab = context.waitForEvent("page");
  await page.getByRole("link", { name: "Foreman" }).click({ modifiers: ["ControlOrMeta"] });
  const foreman = await foremanTab;
  await expect(foreman.getByRole("heading", { name: "Review timecards" })).toBeVisible();
  await expect(page).toHaveURL(/#worker$/);

  const homeTab = context.waitForEvent("page");
  await foreman.getByRole("link", { name: /^FieldLedger/ }).click({ modifiers: ["ControlOrMeta"] });
  const home = await homeTab;
  await expect(button(home, "Try the demo")).toBeVisible();
  await expect(foreman).toHaveURL(/#foreman$/);

  const shiftClickAllowed = await page.getByRole("link", { name: "Demo overview" }).evaluate((link) =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })));
  expect(shiftClickAllowed).toBe(true);
});

test("the full workflow reflows at 320px with 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 750 });
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    document.documentElement.style.fontFamily = "Verdana, 'DejaVu Sans', sans-serif";
  });

  async function expectTextToFit(selector: string) {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const title = page.locator(selector).first();
    await expect(title).toBeVisible();
    expect(await title.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every((line) => line.left >= bounds.left - 1 && line.right <= bounds.right + 1);
    })).toBe(true);
  }

  async function expectReadableDate() {
    await expectTextToFit(".card-row-title strong");
    const dateLines = await page.locator(".card-row-title strong").first().evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(dateLines).toBeLessThanOrEqual(3);
  }

  await expectTextToFit(".hero h1");
  expect(await page.locator(".hero-copy").evaluate((copy) =>
    copy.getBoundingClientRect().right <= copy.parentElement!.getBoundingClientRect().right)).toBe(true);
  expect(await page.locator(".hero-image figcaption").evaluate((caption) =>
    caption.getBoundingClientRect().top >= caption.parentElement!.getBoundingClientRect().top)).toBe(true);
  await button(page, "Try the demo").click();
  await expectTextToFit(".workspace-heading h1");
  await expectReadableDate();
  await submit(page, "7");
  await button(page, "Go to foreman").click();
  await expectTextToFit(".workspace-heading h1");
  await expectReadableDate();
  await button(page, "Return with a note").click();
  await page.getByLabel("Correction note").fill("Please confirm the final hour.");
  await button(page, "Send back to worker").click();
  await button(page, "Go to worker").click();
  await expectTextToFit(".workspace-heading h1");
  await page.getByLabel("Hours worked").fill("8");
  await button(page, "Resubmit timecard").click();
  await button(page, "Go to foreman").click();
  await button(page, "Approve timecard").click();
  await button(page, "Go to manager").click();
  await expectTextToFit(".workspace-heading h1");
  await expect(page.locator("#approved-total")).toHaveText("$10,100");
});
