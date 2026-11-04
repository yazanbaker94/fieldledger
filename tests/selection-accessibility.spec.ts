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
