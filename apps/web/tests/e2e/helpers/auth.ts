import { test as base, expect, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'

export const USERS = {
  admin:    { email: 'admin@VynOps.io',    password: 'admin123',    role: 'admin'    },
  operator: { email: 'operator@VynOps.io', password: 'operator123', role: 'operator' },
  viewer:   { email: 'viewer@VynOps.io',   password: 'viewer123',   role: 'viewer'   },
}

const STORAGE_DIR = path.resolve('tests/e2e/.auth')

export async function loginAs(page: Page, user: keyof typeof USERS = 'admin') {
  const u = USERS[user]
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(u.email)
  await page.getByLabel(/password/i).fill(u.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 })
}

// Fixture that auto-logs in as admin before each test
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await loginAs(page, 'admin')
    await use(page)
  },
})

export { expect }
