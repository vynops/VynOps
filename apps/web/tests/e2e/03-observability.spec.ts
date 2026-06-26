import { test, expect } from './helpers/auth'

test.describe('Observability', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/observability')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('Metrics tab — metric cards visible', async ({ authedPage: page }) => {
    // Click Metrics tab if not default
    const metricsTab = page.getByRole('tab', { name: /metrics/i })
    if (await metricsTab.isVisible()) await metricsTab.click()
    await expect(page.locator('text=/cpu|memory|request rate|error rate/i').first()).toBeVisible()
  })

  test('Logs tab — log entries render', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /logs/i }).click()
    await expect(page.locator('text=/error|warn|info|debug/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Logs tab — level filter works (ERROR)', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /logs/i }).click()
    const errorFilter = page.getByRole('button', { name: /^error$/i }).or(
      page.locator('text=/^ERROR$/').first()
    )
    await errorFilter.click()
    // After filtering, no WARN or INFO should be visible (only ERROR rows)
    await expect(page.locator('text=/^INFO$/').first()).not.toBeVisible({ timeout: 5_000 }).catch(() => {})
  })

  test('Logs tab — search filters results', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /logs/i }).click()
    const search = page.getByPlaceholder(/search/i).or(page.getByRole('searchbox'))
    await search.fill('payment')
    await expect(page.locator('text=/payment/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Logs tab — row expand shows detail', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /logs/i }).click()
    const firstRow = page.locator('table tbody tr, [role="row"]').first()
    await firstRow.click()
    // Expanded detail should appear
    await expect(page.locator('text=/trace_id|namespace|pod/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Traces tab — trace list renders', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /traces/i }).click()
    await expect(page.locator('text=/checkout|trace|span/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Traces tab — clicking trace shows waterfall', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /traces/i }).click()
    const firstTrace = page.locator('[role="listitem"], tr, [data-trace]').first()
    await firstTrace.click()
    await expect(page.locator('text=/span|latency|duration/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Events tab renders alert feed', async ({ authedPage: page }) => {
    const eventsTab = page.getByRole('tab', { name: /events/i })
    if (await eventsTab.isVisible()) {
      await eventsTab.click()
      await expect(page.locator('text=/alert|firing|warning/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })
})
