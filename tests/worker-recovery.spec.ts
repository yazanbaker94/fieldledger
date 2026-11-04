import { expect, test, type Page } from "@playwright/test";

async function sendForCorrection(page: Page, hours: string, note: string) {
  await page.getByLabel("Hours worked").fill(hours);
  await page.getByRole("button", { name: "Submit timecard" }).click();
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await page.getByRole("button", { name: "Return with a note" }).click();
  await page.getByLabel("Correction note").fill(note);
  await page.getByRole("button", { name: "Send back to worker" }).click();
  await page.getByRole("button", { name: "Go to worker" }).waitFor();
}

test("editing after a lost submission response keeps the original entry pending confirmation", async ({ page, context }) => {
  await page.goto("/#worker");
  const hours = page.getByLabel("Hours worked");
  const submit = page.getByRole("button", { name: "Submit timecard" });
  let savedStatus = 0;
  await page.route("**/api/timecards", async route => {
    savedStatus = (await route.fetch()).status();
    await route.abort();
  }, { times: 1 });
  await submit.click();
  await expect(page.getByText("An earlier submission is still unconfirmed.")).toBeVisible();
  expect(savedStatus).toBe(200);

  await hours.fill("7");
  await expect(page.getByText("An earlier submission is still unconfirmed.")).toBeVisible();
  await expect(page.getByText(/Original entry: 8 hrs/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Recovered your submitted timecard.")).toBeVisible();
  await page.getByRole("button", { name: "Go to foreman" }).click();
  await expect(page.getByRole("region", { name: "Timecard review" })).toContainText("8 hrs");

  const workspace = await (await context.request.get("/api/workspace")).json();
  expect(workspace.project.pendingCents).toBe(40_000);
  expect(workspace.timecards.filter((card: { status: string }) => card.status === "pending")).toHaveLength(1);
});

test("an unsaved submission can be retried only after restoring its original details", async ({ page }) => {
  await page.goto("/#worker");
  let originalRequestId: string;
  await page.route("**/api/timecards", async route => {
    originalRequestId = route.request().postDataJSON().requestId;
    await route.abort();
  }, { times: 1 });
  const submit = page.getByRole("button", { name: "Submit timecard" });
  const hours = page.getByLabel("Hours worked");
  await submit.click();
  await expect(page.getByText("An earlier submission is still unconfirmed.")).toBeVisible();
  await hours.fill("7");
  await page.getByRole("button", { name: "Check saved submission" }).click();
  await expect(page.getByRole("alert")).toContainText("Retry with the original details.");
  await expect(submit).toBeDisabled();
  await page.getByRole("button", { name: "Restore original details" }).click();
  await expect(hours).toHaveValue("8");
  const retried = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/timecards"));
  await submit.click();
  await expect(page.getByText("Timecard submitted for review.", { exact: true })).toBeVisible();
  expect((await retried).postDataJSON()).toMatchObject({ requestId: originalRequestId!, hours: 8 });
});

test("an old Worker correction link stays on its timecard and requires a deliberate new entry", async ({ page, context }) => {
  await page.goto("/#worker");
  await sendForCorrection(page, "7", "Please add the final hour.");
  await page.getByRole("button", { name: "Go to worker" }).click();
  const link = page.url();
  await page.getByLabel("Hours worked").fill("8");
  await page.getByRole("button", { name: "Resubmit timecard" }).click();
  await expect(page.getByText("Timecard resubmitted for review.", { exact: true })).toBeVisible();

  const other = await context.newPage();
  await other.goto("/#worker");
  await sendForCorrection(other, "3", "This note is on a different card.");
  await page.reload();
  const linked = page.getByRole("region", { name: "Linked timecard" });
  await expect(linked).toContainText("8 hrs");
  await expect(linked).toContainText("Pending");
  await expect(linked).toContainText("Please add the final hour.");
  await expect(page.getByText("This note is on a different card.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit timecard" })).toHaveCount(0);
  await expect(page).toHaveURL(link);

  await page.getByRole("button", { name: "Open new timecard form" }).click();
  await expect(page).toHaveURL(/#worker$/);
  await expect(page.getByRole("button", { name: "Submit timecard" })).toBeVisible();

  await other.getByRole("button", { name: "Reset demo" }).click();
  await other.getByRole("button", { name: "Reset workspace" }).click();
  await expect(other.getByText("A fresh workspace is ready.")).toBeVisible();
  await page.goto(link);
  await page.reload();
  await expect(linked).toContainText("This timecard is unavailable in your current workspace.");
  await expect(page.getByRole("button", { name: "Submit timecard" })).toHaveCount(0);
});
