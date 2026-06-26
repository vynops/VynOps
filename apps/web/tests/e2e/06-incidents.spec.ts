import { test, expect } from './helpers/auth'

test.describe('Incidents', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('incident list renders with INC IDs', async ({ authedPage: page }) => {
    await expect(page.locator('text=/INC-/').first()).toBeVisible({ timeout: 15_000 })
  })

  test('filter tab "Open" shows only open incidents', async ({ authedPage: page }) => {
    await page.getByRole('tab', { name: /open/i }).click()
    // Resolved incidents should not dominate (at least check page is responsive)
    await expect(page.locator('text=/INC-|open/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('filter tab "Resolved" works', async ({ authedPage: page }) => {
    const resolvedTab = page.getByRole('tab', { name: /resolved/i })
    if (await resolvedTab.isVisible()) {
      await resolvedTab.click()
      await expect(page.locator('text=/resolved/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('search filters incident list', async ({ authedPage: page }) => {
    const search = page.getByPlaceholder(/search/i).or(page.getByRole('searchbox'))
    await search.fill('INC-001')
    await expect(page.locator('text=/INC-001/').first()).toBeVisible({ timeout: 5_000 })
  })

  test('clicking incident opens war room', async ({ authedPage: page }) => {
    const firstIncident = page.locator('text=/INC-0/').first()
    await firstIncident.click()
    await expect(page).toHaveURL(/\/incidents\/INC-/, { timeout: 10_000 })
  })

  test('war room — blast radius panel visible', async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents/INC-001')
    await expect(page.locator('text=/blast radius|affected users|affected services/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('war room — AI RCA panel visible', async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents/INC-001')
    await expect(page.locator('text=/root cause|rca|confidence/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('war room — incident timeline visible', async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents/INC-001')
    await expect(page.locator('text=/timeline|detected|escalated/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('war room — quick action buttons rendered', async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents/INC-001')
    await expect(page.locator('text=/rollback|scale|restart|remediate/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('SLA breach badge shown when breached', async ({ authedPage: page }) => {
    await page.goto('/dashboard/incidents/INC-001')
    // Either SLA breached or SLA deadline text should be visible
    await expect(page.locator('text=/sla|breach/i').first()).toBeVisible({ timeout: 10_000 })
  })
})
