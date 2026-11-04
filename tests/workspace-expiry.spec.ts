import { expect, test } from '@playwright/test'

for (const mode of ['marked', 'legacy'] as const) {
  test(`a delayed ${mode} read after expiry cannot replace another tab’s fresh session`, async ({ page, context }) => {
    const timecards = page.getByRole('region', { name: 'My timecards' })
    await page.goto('/#worker')
    await expect(timecards).toBeVisible()
    await context.clearCookies({ name: /^(?:__Host-)?fieldledger$/ })

    let release = () => {}
    let recordResponse = (_response: Response) => {}
    const delayed = new Promise<void>((resolve) => { release = resolve })
    const reachedServer = new Promise<Response>((resolve) => { recordResponse = resolve })
    await page.route('**/api/workspace', async (route) => {
      const request = route.request()
      const headers = await request.allHeaders()
      if (mode === 'legacy') delete headers['x-demo-workspace']

      // The separate HTTP request lets Chromium apply a cookie only once the held response is released.
      const response = await fetch(request.url(), { headers })
      const body = await response.text()
      const cookie = response.headers.get('Set-Cookie')
      const retryAfter = response.headers.get('Retry-After')
      recordResponse(response)
      await delayed
      await route.fulfill({
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie && { 'Set-Cookie': cookie }),
          ...(retryAfter && { 'Retry-After': retryAfter }),
        },
        body,
      })
    }, { times: 1 })

    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    let oldResponse: Response
    try {
      oldResponse = await reachedServer
      const fresh = await context.newPage()
      await fresh.goto('/#worker')
      await fresh.getByLabel('Hours worked').fill('3.21')
      await fresh.getByRole('button', { name: 'Submit timecard', exact: true }).click()
      await expect(fresh.getByText('Timecard submitted for review.', { exact: true })).toBeVisible()
    } finally {
      release()
    }

    expect(oldResponse.status).toBe(mode === 'legacy' ? 429 : 409)
    expect(oldResponse.headers.get('Set-Cookie')).toBeNull()
    if (mode === 'legacy') await expect(page.getByText(/Couldn’t refresh the workspace/)).toBeVisible()
    else await expect(timecards).toContainText('3.21 hrs')

    await page.reload()
    await expect(timecards).toContainText('3.21 hrs')
  })
}
