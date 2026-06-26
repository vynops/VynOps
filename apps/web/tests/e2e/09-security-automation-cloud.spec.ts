import { test, expect } from './helpers/auth'

test.describe('Security', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/security')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('CIS benchmark findings visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/cis|benchmark|finding|control/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('severity badges present (critical/high/medium)', async ({ authedPage: page }) => {
    await expect(page.locator('text=/critical|high|medium|low/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('one-click fix button visible', async ({ authedPage: page }) => {
    await expect(page.locator('button:has-text(/fix|remediate|apply/i), text=/one-click|fix now/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('security score / overall rating visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/score|rating|\\d+%|pass|fail/i').first()).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('Automation', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/automation')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('runbook list renders', async ({ authedPage: page }) => {
    await expect(page.locator('text=/runbook|playbook|restart|scale/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('automation history visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/history|executed|last run|status/i').first()).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('Cloud', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/cloud')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('provider cards (AWS/Azure/GCP) visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/aws|azure|gcp|google cloud/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('resource table renders', async ({ authedPage: page }) => {
    await expect(page.locator('table tbody tr, [role="row"]').first()).toBeVisible({ timeout: 15_000 })
  })
})
