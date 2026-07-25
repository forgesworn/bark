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
      // A page that fakes the provider's postMessage protocol must get
      // silence, not a response — a response would fingerprint Bark. Probe
      // from the first moment of the document and keep probing: the exposure
      // verdict costs a chrome.storage round trip, so the interesting window
      // is the first few milliseconds, before a page's own scripts would
      // normally get a turn. Any response to any probe means a hidden origin
      // was served.
      await page.addInitScript(() => {
        window.__barkSawResponse = new Promise((resolve) => {
          window.addEventListener('message', (event) => {
            if (event.data?.type === 'bark-response') resolve(true)
          })
          let id = 0
          const probe = setInterval(() => {
            window.postMessage(
              { type: 'bark-request', id: ++id, method: 'getPublicKey' },
              window.location.origin,
            )
            if (id >= 60) {
              clearInterval(probe)
              // A forwarded request retries through MV3 service-worker
              // wake-up for several seconds before it can answer, so a short
              // wait here would read as silence whatever the bridge did.
              setTimeout(() => resolve(false), 12_000)
            }
          }, 5)
        })
      })

      await page.goto(url)
      expect(await page.evaluate(() => typeof window.nostr)).toBe('undefined')
      expect(await page.evaluate(() => window.__barkSawResponse)).toBe(false)
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
