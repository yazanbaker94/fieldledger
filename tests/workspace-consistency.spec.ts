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

test('a saved submission stays visible and blocks a second write after its refresh fails', async ({ page, context }) => {
  await page.goto('/#worker')
  const submit = button(page, 'Submit timecard')
  await expect(submit).toBeEnabled()
  await page.route('**/api/workspace', (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }), { times: 1 })
  await submit.click()
  await expect(page.getByText('Timecard submitted for review.')).toBeVisible()
  const list = page.getByRole('region', { name: 'My timecards' })
  await expect(list.getByText('Pending', { exact: true })).toHaveCount(1)
  await expect(submit).toBeDisabled()
  await expect(page.getByText('Refresh before making another change.')).toBeVisible()
  const data = await (await context.request.get('/api/workspace')).json()
  expect(data.project.pendingCents).toBe(40_000)

  await button(page, 'Refresh workspace').press('Enter')
  await expect(submit).toBeEnabled()
  await expect(page.locator('#main-content')).toBeFocused()
  await expect(list.getByText('Pending', { exact: true })).toHaveCount(1)
})

test('a held verification snapshot stays retired while another tab resets', async ({ page, context }) => {
  await page.goto('/#worker')
  await expect(button(page, 'Submit timecard')).toBeEnabled()
  const other = await context.newPage()
  await other.goto('/#manager')
  await expect(other.locator('#approved-total')).toHaveText('$9,700')

  let finishSnapshot = () => {}
  let snapshotReady = () => {}
  let finishReset = () => {}
  let resetReady = () => {}
  const snapshot = new Promise<void>((resolve) => { snapshotReady = resolve })
  const heldSnapshot = new Promise<void>((resolve) => { finishSnapshot = resolve })
  const resetStarted = new Promise<void>((resolve) => { resetReady = resolve })
  const heldReset = new Promise<void>((resolve) => { finishReset = resolve })
  let submitted = false
  await page.route('**/api/timecards', (route) => {
    submitted = true
    return route.continue()
  }, { times: 1 })
  await page.route('**/api/workspace', async (route) => {
    if (!submitted) return route.continue()
    submitted = false
    const response = await route.fetch()
    expect((await response.json()).project.pendingCents).toBe(16_050)
    snapshotReady()
    await heldSnapshot
    await route.fulfill({ response })
  })
  await other.route('**/api/reset', async (route) => {
    resetReady()
    await heldReset
    await route.continue()
  }, { times: 1 })

  await page.getByLabel('Hours worked').fill('3.21')
  await button(page, 'Submit timecard').click()
  try {
    await snapshot
    await button(other, 'Reset demo').click()
    await button(other, 'Reset workspace').click()
    await resetStarted
    finishSnapshot()
    await expect(page.getByRole('alert')).toContainText('Another tab is resetting this workspace.')
    await expect(button(page, 'Go to foreman')).toHaveCount(0)
    await expect(button(page, 'Submit timecard')).toBeDisabled()
  } finally {
    finishSnapshot()
    finishReset()
  }
  await expect(other.getByText('A fresh workspace is ready.')).toBeVisible()
  await expect(button(page, 'Submit timecard')).toBeEnabled()
  await page.getByRole('navigation', { name: 'Demo role' }).getByRole('link', { name: 'Foreman', exact: true }).click()
  await expect(button(page, 'Approve timecard')).toHaveCount(0)
  await expect(page.getByText('3.21 hrs', { exact: true })).toHaveCount(0)
})

test('a reset from a client without tab signaling still invalidates an old snapshot', async ({ page, context }) => {
  await page.goto('/#worker')
  await expect(button(page, 'Submit timecard')).toBeEnabled()
  const original = await (await context.request.get('/api/workspace')).json()

  let release = () => {}
  let captured = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const snapshot = new Promise<void>((resolve) => { captured = resolve })
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch()
    expect((await response.json()).project.pendingCents).toBe(40_000)
    captured()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  await button(page, 'Submit timecard').click()
  try {
    await snapshot
    const reset = await context.request.post('/api/reset', { headers: { 'X-Demo-Workspace': original.workspaceId }, data: {} })
    expect(reset.ok()).toBe(true)
    expect((await reset.json()).workspaceId).not.toBe(original.workspaceId)
  } finally {
    release()
  }

  await expect(page.getByRole('alert')).toContainText('The demo workspace changed.')
  await expect(button(page, 'Go to foreman')).toHaveCount(0)
  await expect(button(page, 'Submit timecard')).toBeEnabled()
  await expect(page.getByRole('region', { name: 'My timecards' }).getByText('Pending', { exact: true })).toHaveCount(0)
})

test('entering Manager verifies cached costs before labeling them live', async ({ page, context }) => {
  await page.goto('/#worker')
  await submit(page, '8')
  await button(page, 'Go to foreman').click()
  const other = await context.newPage()
  await other.goto(page.url())
  let start = () => {}
  let approveReady = () => {}
  const approval = new Promise<void>((resolve) => { approveReady = resolve })
  const heldApproval = new Promise<void>((resolve) => { start = resolve })
  await other.route('**/api/timecards/*/decision', async (route) => {
    approveReady()
    await heldApproval
    await route.continue()
  }, { times: 1 })
  await button(other, 'Approve timecard').click()
  try {
    await approval
    await page.getByRole('navigation', { name: 'Demo role' }).getByRole('link', { name: 'Worker', exact: true }).click()
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/workspace') && response.ok())
    await refocus(page)
    expect((await (await refreshed).json()).project.approvedCents).toBe(970_000)
  } finally {
    start()
  }
  await expect(button(other, 'Go to manager')).toBeVisible()

  let release = () => {}
  const heldRefresh = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/workspace', async (route) => {
    await heldRefresh
    await route.continue()
  }, { times: 1 })
  await page.getByRole('navigation', { name: 'Demo role' }).getByRole('link', { name: 'Manager', exact: true }).click()
  try {
    await expect(page.getByText('Last saved project costs')).toBeVisible()
    await expect(page.locator('#approved-total')).toHaveText('$9,700')
  } finally {
    release()
  }
  await expect(page.locator('#approved-total')).toHaveText('$10,100')
  await expect(page.getByText('Live project costs')).toBeVisible()
})

for (const scenario of ['delayed verification', 'failed verification'] as const) {
  test(`a ${scenario} cannot rewind newer Manager costs in the same workspace`, async ({ page, context }) => {
    await page.goto('/#worker')
    await submit(page, '8')
    await submit(page, '5')
    const original = await (await context.request.get('/api/workspace')).json()
    const first = original.timecards.find((card: { status: string; hours: number }) => card.status === 'pending' && card.hours === 8)
    const second = original.timecards.find((card: { status: string; hours: number }) => card.status === 'pending' && card.hours === 5)
    await page.goto(`/#foreman?card=${first.id}`)
    const other = await context.newPage()
    await other.goto(`/#foreman?card=${second.id}`)
    await expect(button(other, 'Approve timecard')).toBeEnabled()

    let approved = false
    let release = () => {}
    let captured = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const snapshot = new Promise<void>((resolve) => { captured = resolve })
    await page.route('**/api/timecards/*/decision', async (route) => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      if (scenario === 'failed verification') {
        expect((await response.json()).project.approvedCents).toBe(1_010_000)
        captured()
        await held
      }
      approved = true
      await route.fulfill({ response })
    }, { times: 1 })
    await page.route('**/api/workspace', async (route) => {
      if (!approved) return route.continue()
      approved = false
      if (scenario === 'failed verification') return route.fulfill({ status: 503, json: { message: 'Unavailable' } })
      const response = await route.fetch()
      const data = await response.json()
      expect(data.workspaceId).toBe(original.workspaceId)
      expect(data.project.approvedCents).toBe(1_010_000)
      captured()
      await held
      await route.fulfill({ response })
    })

    const manager = page.getByRole('navigation', { name: 'Demo role' }).getByRole('link', { name: 'Manager', exact: true })
    const approvedTotal = page.locator('#approved-total')
    const approvedRow = page.locator(`[data-card-id="${second.id}"]`)
    await button(page, 'Approve timecard').click()
    try {
      await snapshot
      await button(other, 'Approve timecard').click()
      await expect(button(other, 'Go to manager')).toBeVisible()
      const current = await (await context.request.get('/api/workspace')).json()
      expect(current.workspaceId).toBe(original.workspaceId)
      expect(current.project.approvedCents).toBe(1_035_000)
      await manager.click()
      await expect(approvedTotal).toHaveText('$10,350')
      await expect(approvedRow).toBeVisible()
    } finally {
      release()
    }

    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false')
    if (scenario === 'delayed verification') await expect(page.getByText('Live project costs')).toBeVisible()
    await expect(approvedTotal).toHaveText('$10,350')
    await expect(approvedRow).toBeVisible()
  })
}
