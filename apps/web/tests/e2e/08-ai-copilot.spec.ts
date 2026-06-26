import { test, expect } from './helpers/auth'

test.describe('AI Copilot', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/dashboard/ai-copilot')
    await expect(page.locator('body')).not.toContainText('Internal Server Error')
  })

  test('page loads without error', async ({ authedPage: page }) => {
    await expect(page).not.toHaveTitle(/error|500/i)
  })

  test('chat input box is visible', async ({ authedPage: page }) => {
    const input = page.getByPlaceholder(/ask|message|query/i).or(page.locator('textarea')).first()
    await expect(input).toBeVisible({ timeout: 15_000 })
  })

  test('suggested prompt chips visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/show me|what is|why|explain|diagnose/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('investigations/history panel visible', async ({ authedPage: page }) => {
    await expect(page.locator('text=/investigation|history|past/i').first()).toBeVisible({ timeout: 10_000 })
  })

  test('sending a message gets a response', async ({ authedPage: page }) => {
    const input = page.getByPlaceholder(/ask|message|query/i).or(page.locator('textarea')).first()
    await input.fill('What is the current cluster health?')
    await page.keyboard.press('Enter')
    // Wait for AI response or demo response
    await expect(page.locator('text=/cluster|health|status|error/i').nth(1)).toBeVisible({ timeout: 30_000 })
  })

  test('suggested chip sends pre-built query', async ({ authedPage: page }) => {
    const chip = page.locator('text=/show me|what is|explain/i').first()
    await chip.click()
    // Message should appear in chat
    await expect(page.locator('[role="log"] li, .message, [data-role="user"]').first()).toBeVisible({ timeout: 10_000 })
  })
})
