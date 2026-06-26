import { test, expect } from './helpers/auth'

test.describe('Infrastructure', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/infrastructure')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('cluster summary cards render', async ({ authedPage: page }) => {
    await expect(page.locator('text=/cpu|memory|nodes/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('cluster-wide KPI strip shows', async ({ authedPage: page }) => {
    await expect(page.locator('text=/total cpu|total memory|cores/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Nodes tab — node table renders', async ({ authedPage: page }) => {
    const nodesTab = page.getByRole('tab', { name: /nodes/i })
    if (await nodesTab.isVisible()) await nodesTab.click()
    await expect(page.locator('table tbody tr, [role="row"]').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Nodes tab — expanding node shows detail', async ({ authedPage: page }) => {
    const nodesTab = page.getByRole('tab', { name: /nodes/i })
    if (await nodesTab.isVisible()) await nodesTab.click()
    const firstRow = page.locator('table tbody tr').first()
    await firstRow.click()
    await expect(page.locator('text=/disk|network|kernel|instance type/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Storage tab — PV table renders', async ({ authedPage: page }) => {
    const storageTab = page.getByRole('tab', { name: /storage/i })
    if (await storageTab.isVisible()) {
      await storageTab.click()
      await expect(page.locator('text=/bound|available|pv|persistent/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('Network tab — per-node network table renders', async ({ authedPage: page }) => {
    const networkTab = page.getByRole('tab', { name: /network/i })
    if (await networkTab.isVisible()) {
      await networkTab.click()
      await expect(page.locator('text=/mbps|ingress|egress/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('Databases tab — database cards render', async ({ authedPage: page }) => {
    const dbTab = page.getByRole('tab', { name: /database/i })
    if (await dbTab.isVisible()) {
      await dbTab.click()
      await expect(page.locator('text=/postgres|redis|kafka/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('Databases tab — incident badge shows on critical db', async ({ authedPage: page }) => {
    const dbTab = page.getByRole('tab', { name: /database/i })
    if (await dbTab.isVisible()) {
      await dbTab.click()
      // postgres-payments should have incident badge
      await expect(page.locator('text=/INC-001|incident/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })
})
