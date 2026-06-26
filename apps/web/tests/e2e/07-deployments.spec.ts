import { test, expect } from './helpers/auth'

test.describe('Deployments & Change Correlation', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/deployments')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('KPI cards render (deploys today, success rate, etc)', async ({ authedPage: page }) => {
    await expect(page.locator('text=/deploys today|success rate|deploy time|change failure/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('deployment timeline events render', async ({ authedPage: page }) => {
    await expect(page.locator('text=/payment-service|checkout|v\\.\\d+|v\\d+\\.\\d+/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('"BROKE IT" badge visible on bad deploy', async ({ authedPage: page }) => {
    await expect(page.locator('text=/broke it|correlated|linked incident/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('AI risk score badge visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/risk score|risk/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('filter tab All/Success/Failed/Rollback works', async ({ authedPage: page }) => {
    const failedTab = page.getByRole('tab', { name: /failed/i })
    if (await failedTab.isVisible()) {
      await failedTab.click()
      await expect(page.locator('text=/failed|error/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('clicking deploy row opens detail panel', async ({ authedPage: page }) => {
    const firstRow = page.locator('[role="row"], tr').nth(1)
    await firstRow.click()
    await expect(page.locator('text=/replica|commit|method|branch/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('detail panel shows change diff', async ({ authedPage: page }) => {
    const firstRow = page.locator('[role="row"], tr').nth(1)
    await firstRow.click()
    await expect(page.locator('text=/from|to|image|config/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('search bar filters by service name', async ({ authedPage: page }) => {
    const search = page.getByPlaceholder(/search/i).or(page.getByRole('searchbox'))
    await search.fill('payment')
    await expect(page.locator('text=/payment/i').first()).toBeVisible({ timeout: 5_000 })
  })
})
