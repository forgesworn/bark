import { test, expect } from '@playwright/test'
import { renderedBark, wcagViolations } from './rendered-ui.fixture.js'

async function keyboardActivate(page, locator, key = 'Enter') {
  await locator.focus()
  await page.keyboard.press(key)
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('setup and QR pairing have labelled controls, persistent errors and accessible contrast', async ({ context }) => {
  const { page, errors } = await renderedBark(context)
  await expect(page.getByLabel('Signer address', { exact: true })).toBeVisible()
  await page.locator('#accessibility-settings summary').click()
  await page.getByLabel('Time to review approvals', { exact: true }).selectOption('600000')
  await expect.poll(() => page.evaluate(() => window.barkUiStorage.accessibility?.approvalTimeoutMs)).toBe(600000)
  await expect(page.locator('#accessibility-status')).toHaveAttribute('role', 'status')
  await keyboardActivate(page, page.locator('#pair-btn'))
  await expect(page.locator('#pair-error')).toBeVisible()
  await expect(page.locator('#pair-error')).toHaveAttribute('role', 'alert')
  await expect(page.locator('#pair-error')).toContainText('address')
  expect(await wcagViolations(page)).toEqual([])
  await keyboardActivate(page, page.locator('#qr-show-btn'))
  await expect(page.locator('#qr-relay-input')).toBeFocused()
  await keyboardActivate(page, page.locator('#qr-start-btn'))
  await expect(page.locator('#qr-uri')).toBeVisible()
  await expect(page.locator('#qr-uri')).toBeFocused()
  expect(await wcagViolations(page)).toEqual([])
  await expectNoOverflow(page)
  expect(errors).toEqual([])
})

test('keyboard users can switch signer and persona, expand policies and retain focus after edits', async ({ context }) => {
  const { page, errors } = await renderedBark(context, { paired: true })
  await expect(page.locator('.persona-item')).toHaveCount(2)
  const signer = page.locator('.instance-card').filter({ hasText: 'Personal signer' })
  await keyboardActivate(page, signer, 'Space')
  await expect(signer).toHaveAttribute('aria-pressed', 'true')
  await expect(signer).toBeFocused()
  const persona = page.locator('.persona-item').filter({ hasText: 'work' })
  await keyboardActivate(page, persona)
  await expect(persona).toHaveAttribute('aria-pressed', 'true')
  await expect(persona).toBeFocused()
  await keyboardActivate(page, page.locator('#relay-summary'))
  await expect(page.locator('#relay-summary')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#relay-details')).toContainText('Disconnected')
  await keyboardActivate(page, page.locator('#policy-toggle'), 'Space')
  await expect(page.locator('#policy-toggle')).toHaveAttribute('aria-expanded', 'true')
  const expand = page.locator('.site-expand')
  await keyboardActivate(page, expand)
  await expect(expand).toHaveAttribute('aria-expanded', 'true')
  await expect(expand).toBeFocused()
  const badge = page.locator('#kind-rules-list .policy-action').first()
  await keyboardActivate(page, badge, 'Space')
  await expect(badge).toHaveText('deny')
  await expect(badge).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.barkUiStorage.policies.kindRules['0'])).toBe('deny')
  await page.locator('#disconnect-btn').hover()
  expect(await wcagViolations(page)).toEqual([])
  // Check the whole Tab cycle too: programmatic activation alone would not
  // catch a future negative tabindex or a mouse-only replacement control.
  const visited = new Set()
  for (let index = 0; index < 70; index++) {
    await page.keyboard.press('Tab')
    for (const key of await page.evaluate(() => [document.activeElement.id, ...document.activeElement.classList])) visited.add(key)
  }
  for (const key of ['instance-card', 'persona-item', 'policy-action', 'site-expand', 'policy-toggle', 'relay-summary']) expect(visited.has(key), key).toBe(true)
  await keyboardActivate(page, page.locator('#kind-rules-list .policy-remove').first())
  await expect(page.locator('#kind-rules-list .policy-remove').first()).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.barkUiStorage.policies.kindRules['0'])).toBeUndefined()
  await keyboardActivate(page, page.locator('#reset-policies-btn'))
  await expect(page.getByRole('dialog')).toHaveAccessibleName(/Reset/)
  await expect(page.locator('#confirm-dialog-no')).toBeFocused()
  expect(await wcagViolations(page)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('#reset-policies-btn')).toBeFocused()
  expect(errors).toEqual([])
})

test('expanded policies reflow at 320 CSS pixels with WCAG text spacing and 200 percent text', async ({ context }) => {
  const { page } = await renderedBark(context, { paired: true })
  await page.locator('#policy-toggle').click()
  await page.locator('.site-expand').click()
  await page.locator('#accessibility-settings summary').click()
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' })
  await expectNoOverflow(page)
  // Double computed text sizes, including explicit px sizes, without changing
  // the CSS viewport. Root-only scaling would miss most of this popup's text.
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll('body, body *')]
      .map(element => [element, parseFloat(getComputedStyle(element).fontSize)])
    for (const [element, size] of sizes) element.style.setProperty('font-size', `${size * 2}px`, 'important')
  })
  await expectNoOverflow(page)
  await expect(page.locator('#disconnect-btn')).toBeVisible()
  await expect(page.locator('#add-site-action')).toBeVisible()
})

test('short approval windows begin with visible focus and Enter denies safely', async ({ context }) => {
  const { page, errors } = await renderedBark(context, { approval: true, height: 480 })
  await expect(page.locator('#title')).toBeFocused()
  expect(await page.evaluate(() => {
    const r = document.activeElement.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= innerHeight && scrollY === 0
  })).toBe(true)
  expect(await wcagViolations(page)).toEqual([])
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.fixtureCalls.find(call => call.type === 'bark-approval-response')?.decision)).toBe('deny')
  expect(errors).toEqual([])
})

test('approval announces its final warning once and disables grants at the deadline', async ({ context }) => {
  const { page, errors } = await renderedBark(context, { approval: true, remainingMs: 25_000 })
  await expect(page.locator('#approval-time-warning')).toBeVisible()
  await expect(page.locator('#approval-time-warning')).toHaveAttribute('role', 'status')
  await page.evaluate(() => {
    window.warningChanges = 0
    new MutationObserver(() => window.warningChanges++).observe(document.querySelector('#approval-time-warning'), { childList: true, subtree: true, characterData: true })
  })
  await page.clock.install()
  await page.clock.fastForward(2000)
  expect(await page.evaluate(() => window.warningChanges)).toBe(0)
  await page.clock.fastForward(30_000)
  await expect(page.locator('#allow-btn')).toBeDisabled()
  await expect(page.locator('#trust-btn')).toBeDisabled()
  await expect(page.locator('#deny-btn')).toBeEnabled()
  await expect(page.locator('#approval-time-warning')).toContainText('expired')
  expect(await page.evaluate(() => window.fixtureCalls.some(call => call.type === 'bark-approval-response'))).toBe(false)
  expect(errors).toEqual([])
})
