import { test, expect, USERS, loginAs } from './helpers/auth'

test.describe('Authentication', () => {
  test('login page renders correctly', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: /sign in|login|vynops/i })).toBeVisible()
    await expect(page.getByLabel(/email/i)).toBeVisible()
    await expect(page.getByLabel(/password/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('wrong credentials shows error', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill('wrong@example.com')
    await page.getByLabel(/password/i).fill('wrongpassword')
    await page.getByRole('button', { name: /sign in/i }).click()
    // Should stay on login or show error — not redirect to dashboard
    await expect(page).not.toHaveURL(/\/dashboard/)
  })

  test('admin login succeeds → redirects to dashboard', async ({ page }) => {
    await loginAs(page, 'admin')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('operator login succeeds', async ({ page }) => {
    await loginAs(page, 'operator')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('viewer login succeeds', async ({ page }) => {
    await loginAs(page, 'viewer')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('authenticated user sees name & role badge in header', async ({ page }) => {
    await loginAs(page, 'admin')
    // Header user menu
    await expect(page.getByText(/Alex Karev|admin/i).first()).toBeVisible()
  })

  test('sign out returns to login', async ({ page }) => {
    await loginAs(page, 'admin')
    // Open user menu and click sign out
    const userMenu = page.getByRole('button', { name: /alex karev|user menu|account/i }).first()
    await userMenu.click()
    await page.getByRole('button', { name: /sign out|logout/i }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
  })

  test('protected route redirects unauthenticated user to login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })
})
