import { test, expect } from './helpers/auth'

test.describe('Executive Dashboard', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('KPI cards are visible', async ({ authedPage: page }) => {
    // Should show at least 4 KPI cards (health score, incidents, alerts, uptime)
    const kpiCards = page.locator('[data-testid="kpi-card"], .kpi-card').or(
      page.locator('text=/health score|active incidents|firing alerts|uptime/i').first()
    )
    await expect(kpiCards).toBeVisible({ timeout: 15_000 })
  })

  test('health score shows a number', async ({ authedPage: page }) => {
    await expect(page.locator('text=/\\d+%|\\d+\\.\\d+/').first()).toBeVisible()
  })

  test('service health table renders rows', async ({ authedPage: page }) => {
    // Should have a table with service rows
    const rows = page.locator('table tbody tr, [role="row"]')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  })

  test('cluster summary cards visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/cpu|memory/i').first()).toBeVisible()
  })

  test('active incidents list section present', async ({ authedPage: page }) => {
    await expect(page.locator('text=/incident|INC-/i').first()).toBeVisible()
  })

  test('AI insights feed visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/insight|ai|confidence/i').first()).toBeVisible()
  })
})
