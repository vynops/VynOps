import { test, expect } from './helpers/auth'

test.describe('Kubernetes', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/kubernetes')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('cluster summary strip visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/cluster|node/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('Pods tab — pod table renders', async ({ authedPage: page }) => {
    const podsTab = page.getByRole('tab', { name: /pods/i })
    if (await podsTab.isVisible()) await podsTab.click()
    await expect(page.locator('table tbody tr, [role="row"]').first()).toBeVisible({ timeout: 15_000 })
  })

  test('Pods tab — CrashLoopBackOff pod highlighted', async ({ authedPage: page }) => {
    const podsTab = page.getByRole('tab', { name: /pods/i })
    if (await podsTab.isVisible()) await podsTab.click()
    await expect(page.locator('text=/crashloop|crash/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Pods tab — search filters by pod name', async ({ authedPage: page }) => {
    const podsTab = page.getByRole('tab', { name: /pods/i })
    if (await podsTab.isVisible()) await podsTab.click()
    const search = page.getByPlaceholder(/search/i).or(page.getByRole('searchbox'))
    await search.fill('payment')
    await expect(page.locator('text=/payment/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Clusters tab — cluster cards render', async ({ authedPage: page }) => {
    const clustersTab = page.getByRole('tab', { name: /clusters/i })
    if (await clustersTab.isVisible()) {
      await clustersTab.click()
      await expect(page.locator('text=/cpu|memory|nodes|pods/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('Events tab — K8s events feed renders', async ({ authedPage: page }) => {
    const eventsTab = page.getByRole('tab', { name: /events/i })
    if (await eventsTab.isVisible()) {
      await eventsTab.click()
      await expect(page.locator('text=/warning|normal|reason/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })
})
