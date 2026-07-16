import { test, expect } from './extension.fixture.js'
import { diagnosticUrl, withTestPage } from './nip46-test-helpers.js'
import { buildTrustedSiteRule, DEFAULT_POLICIES } from '../src/policy.js'

/**
 * Privacy mode: window.nostr must be exposed only on origins with a site
 * rule, and hidden origins must get silence — not an error — even when a
 * page synthesises the bridge messages by hand.
 */

async function seedStorage(context, extensionId, storage) {
  const extensionPage = await context.newPage()
  try {
    await extensionPage.goto(diagnosticUrl(extensionId), {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    })
    await extensionPage.evaluate((nextStorage) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('storage seed timed out')), 10_000)
      chrome.storage.local.clear(() => {
        const clearErr = chrome.runtime.lastError
        if (clearErr) {
          clearTimeout(timer)
          reject(new Error(clearErr.message))
          return
        }
        chrome.storage.local.set(nextStorage, () => {
          clearTimeout(timer)
          const setErr = chrome.runtime.lastError
          if (setErr) reject(new Error(setErr.message))
          else resolve()
        })
      })
    }), storage)
  } finally {
    await extensionPage.close()
  }
}

test('hides window.nostr from unlisted origins when privacy mode is on', async ({ context, extensionId }) => {
  await withTestPage(async (url) => {
    await seedStorage(context, extensionId, {
      privacy: { enabled: true },
      policies: DEFAULT_POLICIES,
    })

    const page = await context.newPage()
    try {
      await page.goto(url)

      // Give the exposure check ample time to settle, then assert absence.
      await page.waitForTimeout(1_000)
      expect(await page.evaluate(() => typeof window.nostr)).toBe('undefined')

      // A page that fakes the provider's postMessage protocol must get
      // silence, not a response — a response would fingerprint Bark.
      const sawResponse = await page.evaluate(() => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_500)
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'bark-response') {
            clearTimeout(timer)
            resolve(true)
          }
        })
        window.postMessage(
          { type: 'bark-request', id: 1, method: 'getPublicKey' },
          window.location.origin,
        )
      }))
      expect(sawResponse).toBe(false)
    } finally {
      await page.close()
    }
  })
})

test('exposes window.nostr to whitelisted origins when privacy mode is on', async ({ context, extensionId }) => {
  await withTestPage(async (url) => {
    const origin = new URL(url).origin
    await seedStorage(context, extensionId, {
      privacy: { enabled: true },
      policies: {
        ...DEFAULT_POLICIES,
        siteRules: { [origin]: buildTrustedSiteRule() },
      },
    })

    const page = await context.newPage()
    try {
      await page.goto(url)

      await expect.poll(async () => {
        return await page.evaluate(() => typeof window.nostr?.getPublicKey)
      }).toBe('function')

      // The bridge must actually work end to end: an unpaired call reaching
      // the background and returning its safe error proves the whitelisted
      // path is fully live, not just cosmetically defined.
      const error = await page.evaluate(async () => {
        try {
          await window.nostr.getPublicKey()
          return null
        } catch (err) {
          return err?.message || String(err)
        }
      })
      expect(error).toContain('No Heartwood instance configured')
    } finally {
      await page.close()
    }
  })
})
