import { test, expect } from './extension.fixture.js'
import { fileURLToPath } from 'node:url'
import { callNostr, runtimeMessage, seedDeterministicSigner, withDeterministicNip46Signer } from './nip46-test-helpers.js'

async function v4vPage(context, origin) {
  // A disposable page at the real host exercises manifest matching without
  // accessing an account or using a real signer.
  await context.route(`${origin}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><script>window.initialProvider = typeof window.nostr?.getPublicKey; window.documentMarker = Math.random()</script><title>Bark site recovery</title>',
  }))
  const page = await context.newPage()
  await page.goto(origin)
  return page
}

async function openToolbar(context, extensionId, page) {
  // Wake the worker before triggering the action after an extension reload.
  await runtimeMessage(context, extensionId, { type: 'bark-status' })
  await page.bringToFront()
  const browserCdp = await context.browser().newBrowserCDPSession()
  try {
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] })
    const targetInfo = targetInfos.find(target => target.url === page.url())
    if (!targetInfo) throw new Error(`Missing tab target for ${page.url()}`)
    // Headless Chromium grants activeTab on the real action but has no
    // toolbar popup surface. Run the packaged UI in a background tab so its
    // currentWindow/active-tab query still selects the website.
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo.targetId })
    const opened = context.waitForEvent('page', { timeout: 5000 })
    await context.serviceWorkers().at(-1).evaluate(extensionId => {
      return chrome.tabs.create({ url: `chrome-extension://${extensionId}/popup.html`, active: false })
    }, extensionId)
    const popup = await opened
    await popup.waitForURL(`chrome-extension://${extensionId}/popup.html`)
    await expect(popup.locator('#connected-content')).toBeVisible()
    return popup
  } finally {
    await browserCdp.detach()
  }
}

for (const origin of ['https://v4v.com', 'https://www.v4v.com']) {
  test(`provides NIP-07 before ${origin} runs its first script`, async ({ context, extensionId }) => {
    await withDeterministicNip46Signer(async remote => {
      await seedDeterministicSigner({ context, extensionId, origin, bunkerUri: remote.bunkerUri })
      const page = await v4vPage(context, origin)
      expect(await page.evaluate(() => window.initialProvider)).toBe('function')
      expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
      await runtimeMessage(context, extensionId, { type: 'bark-reset' })
    })
  })
}

test('repeated bridge restoration signs once and preserves the current page and provider', async ({ context, extensionId }) => {
  await withDeterministicNip46Signer(async remote => {
    const origin = 'https://v4v.com'
    await seedDeterministicSigner({ context, extensionId, origin, bunkerUri: remote.bunkerUri })
    const page = await v4vPage(context, origin)
    const marker = await page.evaluate(() => { window.originalProvider = window.nostr; return window.documentMarker })
    for (let i = 0; i < 3; i++) {
      const popup = await openToolbar(context, extensionId, page)
      await popup.close()
    }
    const before = remote.methods.filter(method => method === 'sign_event').length
    expect((await callNostr(page, 'signEvent', { kind: 1, tags: [], content: 'one request' })).pubkey).toBe(remote.pubkey)
    expect(remote.methods.filter(method => method === 'sign_event')).toHaveLength(before + 1)
    expect(await page.evaluate(() => window.nostr === window.originalProvider)).toBe(true)
    expect(await page.evaluate(() => window.documentMarker)).toBe(marker)
    await runtimeMessage(context, extensionId, { type: 'bark-reset' })
  })
})

test('restores an updated extension on an open v4v page without reloading the document', async ({ context, extensionId }) => {
  await withDeterministicNip46Signer(async remote => {
    const origin = 'https://v4v.com'
    await seedDeterministicSigner({ context, extensionId, origin, bunkerUri: remote.bunkerUri })
    const page = await v4vPage(context, origin)
    expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
    const marker = await page.evaluate(() => { window.originalProvider = window.nostr; return window.documentMarker })
    const browserCdp = await context.browser().newBrowserCDPSession()
    try {
      const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../dist/', import.meta.url)) })
      expect(loaded.id).toBe(extensionId)
    } finally {
      await browserCdp.detach()
    }
    const popup = await openToolbar(context, extensionId, page)
    await popup.close()
    expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
    expect((await callNostr(page, 'signEvent', { kind: 1, tags: [], content: 'after extension reload' })).pubkey).toBe(remote.pubkey)
    expect(await page.evaluate(() => window.documentMarker)).toBe(marker)
    expect(await page.evaluate(() => window.nostr === window.originalProvider)).toBe(true)
    await runtimeMessage(context, extensionId, { type: 'bark-reset' })
  })
})

test('enables an http website in the current tab without requiring a secure context or reload', async ({ context, extensionId }) => {
  await withDeterministicNip46Signer(async remote => {
    const origin = 'http://bark-http-recovery.test'
    await seedDeterministicSigner({ context, extensionId, origin, bunkerUri: remote.bunkerUri })
    const page = await v4vPage(context, origin)
    expect(await page.evaluate(() => window.initialProvider)).toBe('undefined')
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
    const marker = await page.evaluate(() => window.documentMarker)
    const popup = await openToolbar(context, extensionId, page)
    await expect(popup.locator('#site-card-btn')).toBeVisible()
    await popup.locator('#site-card-btn').click()
    await expect.poll(() => page.evaluate(() => typeof window.nostr?.getPublicKey)).toBe('function')
    expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
    expect(await page.evaluate(() => window.documentMarker)).toBe(marker)
    await runtimeMessage(context, extensionId, { type: 'bark-reset' })
  })
})
