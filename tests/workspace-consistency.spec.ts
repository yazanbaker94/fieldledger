import { expect, test, type Page } from '@playwright/test'

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function submit(page: Page, hours: string) {
  await page.getByLabel('Hours worked').fill(hours)
  await button(page, 'Submit timecard').click()
  await button(page, 'Go to foreman').waitFor()
}

async function reset(page: Page) {
  await button(page, 'Reset demo').click()
  await button(page, 'Reset workspace').click()
  await expect(page.getByText('A fresh workspace is ready.')).toBeVisible()
}

async function refocus(page: Page) {
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

test('a late submission response cannot bring back a card deleted by another tab reset', async ({ page, context }) => {
  await page.goto('/#worker')
  const other = await context.newPage()
  await other.goto('/#manager')
  await expect(other.locator('#approved-total')).toHaveText('$9,700')

  let release = () => {}
  let saved = () => {}
  const committed = new Promise<void>((resolve) => { saved = resolve })
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/timecards', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    saved()
    await delayed
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByLabel('Hours worked').fill('3.21')
  await button(page, 'Submit timecard').click()
  try {
    await committed
    await reset(other)
  } finally {
    release()
  }

  await expect(page.getByRole('alert')).toContainText('The demo workspace changed.')
  await expect(button(page, 'Go to foreman')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'My timecards' })).not.toContainText('3.21 hrs')
})

test('reset confirmation stays tied to its original workspace and Back closes the dialog', async ({ page, context }) => {
  await page.goto('/')
  await button(page, 'Try the demo').click()
  await button(page, 'Reset demo').click()
  const dialog = page.getByRole('dialog')
  await page.goBack()
  await button(page, 'Try the demo').click()
  await expect(dialog).toHaveCount(0)

  await button(page, 'Reset demo').click()
  const other = await context.newPage()
  await other.goto('/#worker')
  await reset(other)
  await submit(other, '6.13')
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/workspace') && response.ok())
  await refocus(page)
  await refreshed
  await expect(page.locator('section[aria-label="My timecards"]')).toContainText('6.13 hrs')
  await button(page, 'Reset workspace').press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('The demo workspace changed.')
  await expect(button(page, 'Reset demo')).toBeFocused()
  await expect(page.getByRole('region', { name: 'My timecards' })).toContainText('6.13 hrs')
})

test('a lost return response is confirmed after a later correction and shows the current hours', async ({ page, context }) => {
  await page.goto('/#worker')
  await submit(page, '7')
  await button(page, 'Go to foreman').click()
  const cardId = new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('card')
  expect(cardId).toBeTruthy()
  let release = () => {}
  let saved = () => {}
  const committed = new Promise<void>((resolve) => { saved = resolve })
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/timecards/*/decision', async (route) => {
    expect((await route.fetch()).ok()).toBe(true)
    saved()
    await delayed
    await route.abort()
  }, { times: 1 })
  await button(page, 'Return with a note').click()
  await page.getByLabel('Correction note').fill('Please include the final hour.')
  await button(page, 'Send back to worker').click()
  try {
    await committed
    const other = await context.newPage()
    await other.goto(`/#worker?card=${cardId}`)
    await other.getByLabel('Hours worked').fill('8')
    await button(other, 'Resubmit timecard').click()
    await expect(other.getByText('Timecard resubmitted for review.')).toBeVisible()
  } finally {
    release()
  }
  await expect(page.getByText('Timecard returned to the worker.', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Timecard review' }).getByText('8 hrs', { exact: true })).toBeVisible()
  await expect(button(page, 'Approve timecard')).toBeDisabled()
})

test('a failed manager refresh identifies cached costs and offers a retry', async ({ page, context }) => {
  await page.goto('/#manager')
  await expect(page.locator('#approved-total')).toHaveText('$9,700')
  const other = await context.newPage()
  await other.goto('/#worker')
  await submit(other, '8')
  await button(other, 'Go to foreman').click()
  await button(other, 'Approve timecard').click()
  await button(other, 'Go to manager').click()
  await expect(other.locator('#approved-total')).toHaveText('$10,100')

  await page.route('**/api/workspace', (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }), { times: 1 })
  await refocus(page)
  await expect(page.getByText(/Showing data last synced at/)).toBeVisible()
  await expect(page.getByText('Last saved project costs')).toBeVisible()
  await expect(page.locator('#approved-total')).toHaveText('$9,700')
  await button(page, 'Refresh workspace').click()
  await expect(page.locator('#approved-total')).toHaveText('$10,100')
  await expect(page.getByText(/Showing data last synced at/)).toHaveCount(0)
})

test('workspace rate limit preserves the server explanation and waits to enable retry', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/workspace', (route) => route.fulfill({
    status: 429, headers: { 'Retry-After': '5' }, json: { message: 'Too many new demo sessions. Try again later.' },
  }), { times: 1 })
  await page.goto('/#worker')
  await expect(page.getByRole('alert')).toHaveText('Too many new demo sessions. Try again later.')
  await expect(button(page, 'Try again')).toBeDisabled()
  await page.clock.fastForward(5_001)
  await expect(button(page, 'Try again')).toBeEnabled()
  await button(page, 'Try again').click()
  await expect(button(page, 'Submit timecard')).toBeVisible()
})
