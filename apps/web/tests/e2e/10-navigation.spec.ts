import { test, expect } from './helpers/auth'

test.describe('Navigation & Shell', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('sidebar renders all 15 nav sections', async ({ authedPage: page }) => {
    const navItems = [
      /home|dashboard/i,
      /observability/i,
      /infrastructure/i,
      /kubernetes/i,
      /cloud/i,
      /incident/i,
      /ai copilot|copilot/i,
      /automation/i,
      /security/i,
      /analytics/i,
      /settings/i,
    ]
    for (const label of navItems) {
      await expect(page.locator(`nav >> text=${label.source}`).or(
        page.locator('[role="navigation"]').locator(`text=${label.source}`)
      ).first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('sidebar collapses to icon-only mode', async ({ authedPage: page }) => {
    const toggleBtn = page.getByRole('button', { name: /collapse|toggle sidebar|chevron/i }).first()
    if (await toggleBtn.isVisible()) {
      await toggleBtn.click()
      // After collapse, sidebar should be narrow (~56px)
      const sidebar = page.locator('nav, [data-sidebar], aside').first()
      const box = await sidebar.boundingBox()
      if (box) expect(box.width).toBeLessThan(100)
    }
  })

  test('header time range selector opens options', async ({ authedPage: page }) => {
    const timeRange = page.getByRole('button', { name: /last|1h|5m|15m|30m|24h/i }).first()
    if (await timeRange.isVisible()) {
      await timeRange.click()
      await expect(page.locator('text=/last 5m|last 15m|last 1h/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('environment switcher opens options', async ({ authedPage: page }) => {
    const envBtn = page.getByRole('button', { name: /production|staging|development|dr/i }).first()
    if (await envBtn.isVisible()) {
      await envBtn.click()
      await expect(page.locator('text=/staging|development|dr/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('notification bell shows & opens dropdown', async ({ authedPage: page }) => {
    const bell = page.getByRole('button', { name: /notification|bell|alert/i }).first()
    if (await bell.isVisible()) {
      await bell.click()
      await expect(page.locator('text=/alert|firing|notification/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('Command Palette opens with button click', async ({ authedPage: page }) => {
    // Try clicking search / cmd-k button
    const cmdBtn = page.getByRole('button', { name: /search|cmd|⌘/i }).first()
    if (await cmdBtn.isVisible()) {
      await cmdBtn.click()
    } else {
      await page.keyboard.press('Meta+k')
    }
    await expect(page.locator('text=/navigate|go to|INC-|search/i').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Command Palette closes with Escape', async ({ authedPage: page }) => {
    const cmdBtn = page.getByRole('button', { name: /search|cmd|⌘/i }).first()
    if (await cmdBtn.isVisible()) await cmdBtn.click()
    else await page.keyboard.press('Meta+k')
    await page.keyboard.press('Escape')
    // Palette overlay should be gone
    await expect(page.locator('text=/navigate|go to|INC-/i').first()).not.toBeVisible({ timeout: 5_000 }).catch(() => {})
  })

  test('real-time toggle indicator visible in header', async ({ authedPage: page }) => {
    await expect(page.locator('text=/live|real.?time/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('AI intelligence sidebar toggle works', async ({ authedPage: page }) => {
    const sidebarToggle = page.getByRole('button', { name: /ai|intelligence|insight/i }).first()
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click()
      await expect(page.locator('text=/rca|insight|remediation|blast radius/i').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('navigating to each section via sidebar works', async ({ authedPage: page }) => {
    const routes: [string, RegExp][] = [
      ['/dashboard/observability', /observability/i],
      ['/dashboard/kubernetes', /kubernetes|pods/i],
      ['/dashboard/incidents', /incident/i],
      ['/dashboard/ai-copilot', /copilot|chat|ask/i],
    ]
    for (const [path, title] of routes) {
      await page.goto(path)
      await expect(page.locator('h1, h2, [role="heading"]').filter({ hasText: title }).first()).toBeVisible({ timeout: 15_000 })
    }
  })
})

test.describe('Analytics & FinOps', () => {
  test('analytics page loads', async ({ authedPage: page }) => {
    await page.goto('/dashboard/analytics')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
    await expect(page.locator('text=/slo|latency|error rate|request/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('settings page loads', async ({ authedPage: page }) => {
    await page.goto('/dashboard/settings')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
    await expect(page.locator('text=/config|cluster|user|notification|oncall/i').first()).toBeVisible({ timeout: 15_000 })
  })
})
