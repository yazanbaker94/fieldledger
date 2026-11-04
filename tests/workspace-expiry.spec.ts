import { expect, test } from '@playwright/test'

for (const mode of ['marked', 'legacy'] as const) {
  test(`a delayed ${mode} read after expiry cannot replace another tab’s fresh session`, async ({ page, context }) => {
    const timecards = page.getByRole('region', { name: 'My timecards' })
    await page.goto('/#worker')
    await expect(timecards).toBeVisible()
    const workDate = await page.getByLabel('Work date').inputValue()
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
    const status = mode === 'legacy' ? 429 : 409
    let delivered: Promise<unknown>
    try {
      const oldResponse = await reachedServer
      expect(oldResponse.status).toBe(status)
      expect(oldResponse.headers.get('Set-Cookie')).toBeNull()

      // The context shares Chromium's cookies. Open and save directly while the old tab's fetch is held.
      const fresh = await context.request.get('/api/workspace', { headers: { 'X-Demo-Open': '1' } })
      expect(fresh.ok()).toBe(true)
      const { workspaceId } = await fresh.json()
      const saved = await context.request.post('/api/timecards', {
        headers: { 'X-Demo-Workspace': workspaceId, 'X-Demo-Role': 'worker' },
        data: { workDate, hours: 3.21, requestId: crypto.randomUUID() },
      })
      expect(saved.ok()).toBe(true)
      delivered = page.waitForResponse((response) => response.url().endsWith('/api/workspace') && response.status() === status)
    } finally {
      release()
    }
    await delivered

    await page.reload()
    await expect(timecards).toContainText('3.21 hrs')
  })
}
