// Generates the store listing screenshots (1280×800) and promo tile by
// driving the built extension through Playwright against the deterministic
// local NIP-46 signer. Run `npm run build` first, then:
//
//   node scripts/store-screenshots.mjs
//
// Output lands in docs/store-assets/.

import { chromium } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nip19 } from 'nostr-tools'
import {
  DeterministicNip46Signer,
  runtimeMessage,
  seedDeterministicSigner,
  withTestPage,
} from '../e2e/nip46-test-helpers.js'
import { buildTrustedSiteRule, DEFAULT_POLICIES } from '../src/policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '..', 'dist')
const outDir = path.resolve(__dirname, '..', 'docs', 'store-assets')
mkdirSync(outDir, { recursive: true })

const VIEWPORT = { width: 1280, height: 800 }

/** Deterministic signer that also answers Heartwood persona RPCs. */
class HeartwoodDemoSigner extends DeterministicNip46Signer {
  handleRequest(request) {
    if (request.method === 'heartwood_list_identities') {
      return {
        result: JSON.stringify([
          { pubkey: this.pubkey, name: 'master' },
          { pubkey: 'a1'.repeat(32), name: 'nostr' },
          { pubkey: 'b2'.repeat(32), name: 'market' },
          { pubkey: 'c3'.repeat(32), name: 'support' },
        ]),
      }
    }
    return super.handleRequest(request)
  }
}

/** Centre the extension page on a dark backdrop for a store-ready frame. */
async function frame(page, bodyWidth) {
  await page.addStyleTag({
    content: `
      html {
        background: radial-gradient(900px 500px at 50% -10%, #1e2d1e, #0a0a12 65%);
        min-height: 100vh;
      }
      body {
        width: ${bodyWidth}px !important;
        margin: 48px auto !important;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65), 0 0 0 1px #2e2e3e;
      }
    `,
  })
}

async function openPopup(context, extensionId) {
  const page = await context.newPage()
  await page.setViewportSize(VIEWPORT)
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' })
  await frame(page, 320)
  return page
}

async function shoot(page, name) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(outDir, name) })
  console.log('captured', name)
}

async function clearStorage(context, extensionId) {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/diagnostic.html`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => new Promise((resolve) => chrome.storage.local.clear(resolve)))
  await page.close()
}

async function setStorage(context, extensionId, items) {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/diagnostic.html`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((next) => new Promise((resolve) => chrome.storage.local.set(next, resolve)), items)
  await page.close()
}

const userDataDir = mkdtempSync(path.join(tmpdir(), 'bark-shots-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
  const extensionId = new URL(worker.url()).host

  // 01 — fresh setup screen
  await clearStorage(context, extensionId)
  {
    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#setup-screen.active')
    await shoot(popup, '01-setup.png')
    await popup.close()
  }

  // 02 — QR pairing flow
  {
    const popup = await openPopup(context, extensionId)
    await popup.click('#qr-show-btn')
    await popup.click('#qr-start-btn')
    await popup.waitForSelector('#qr-code svg', { timeout: 10_000 })
    await shoot(popup, '02-qr-pairing.png')
    await popup.click('#qr-cancel-btn')
    await popup.close()
  }

  // 03 — connected to a standard bunker, signing verified
  const standardSigner = await new DeterministicNip46Signer().start()
  {
    await seedDeterministicSigner({
      context,
      extensionId,
      origin: null,
      bunkerUri: standardSigner.bunkerUri,
      trustedOrigin: false,
      instanceName: 'my bunker',
    })
    const primed = await runtimeMessage(context, extensionId, { type: 'bark-prime-signer' }, 35_000)
    if (!primed?.ok) throw new Error(`prime failed: ${primed?.error}`)

    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#connected-content', { state: 'visible', timeout: 20_000 })
    await popup.waitForFunction(() => document.getElementById('sign-status-text')?.textContent === 'Signing ready', null, { timeout: 20_000 })
    await shoot(popup, '03-connected.png')
    await popup.close()
  }

  // 04 — policy settings with per-site kind overrides expanded
  {
    await setStorage(context, extensionId, {
      policies: {
        ...DEFAULT_POLICIES,
        siteRules: {
          'https://snort.social': buildTrustedSiteRule(),
          'https://primal.net': buildTrustedSiteRule(),
        },
      },
    })
    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#connected-content', { state: 'visible', timeout: 20_000 })
    await popup.click('#policy-toggle')
    await popup.waitForSelector('#site-rules-list .policy-item')
    await popup.locator('#site-rules-list .policy-label', { hasText: 'snort.social' }).click()
    await popup.waitForSelector('.site-kind-panel')
    await popup.evaluate(() => document.getElementById('policy-content')?.scrollIntoView())
    await shoot(popup, '04-policies.png')
    await popup.close()
  }
  await standardSigner.close()

  // 05 — Heartwood personas
  const heartwoodSigner = await new HeartwoodDemoSigner().start()
  {
    await seedDeterministicSigner({
      context,
      extensionId,
      origin: null,
      bunkerUri: heartwoodSigner.bunkerUri,
      trustedOrigin: false,
      instanceId: 'heartwood-demo',
      instanceName: 'heartwood',
    })
    // Give the instance card a real npub instead of "connecting...".
    {
      const page = await context.newPage()
      await page.goto(`chrome-extension://${extensionId}/diagnostic.html`, { waitUntil: 'domcontentloaded' })
      await page.evaluate((npub) => new Promise((resolve) => {
        chrome.storage.local.get(['instances'], ({ instances }) => {
          instances[0].npub = npub
          chrome.storage.local.set({ instances }, resolve)
        })
      }), nip19.npubEncode(heartwoodSigner.pubkey))
      await page.close()
    }
    await runtimeMessage(context, extensionId, { type: 'bark-reset' }, 10_000).catch(() => {})
    const primed = await runtimeMessage(context, extensionId, { type: 'bark-prime-signer' }, 35_000)
    if (!primed?.ok) throw new Error(`heartwood prime failed: ${primed?.error}`)

    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#persona-section', { state: 'visible', timeout: 20_000 })
    await popup.waitForFunction(() => document.querySelectorAll('.persona-item').length >= 4, null, { timeout: 20_000 })
    await shoot(popup, '05-personas.png')
    await popup.close()
  }

  // 06 — approval window for an untrusted site's sign request
  await withTestPage(async (url) => {
    const site = await context.newPage()
    await site.goto(url)
    await site.waitForFunction(() => typeof window.nostr?.signEvent === 'function')

    const approvalPromise = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('/approve.html'),
      timeout: 15_000,
    })
    const resultPromise = site.evaluate(() => window.nostr.signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'Hello Nostr, signed through my remote signer with Bark.',
    }).catch((err) => ({ denied: err.message })))

    const approval = await approvalPromise
    await approval.waitForLoadState('domcontentloaded')
    await approval.setViewportSize(VIEWPORT)
    await approval.waitForSelector('#content', { state: 'visible' })
    await frame(approval, 400)
    await shoot(approval, '06-approval.png')

    await approval.getByRole('button', { name: 'Deny' }).click()
    await resultPromise
    await site.close()
  }, { title: 'Nostr web app', body: 'Demo Nostr web app' })
  await heartwoodSigner.close()

  // Promo tile 440×280
  {
    const icon = readFileSync(path.resolve(__dirname, '..', 'src', 'icons', 'bark-128.png')).toString('base64')
    const tile = await context.newPage()
    await tile.setViewportSize({ width: 440, height: 280 })
    await tile.setContent(`<!doctype html><html><head><style>
      * { margin: 0; padding: 0; }
      body {
        width: 440px; height: 280px; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 10px;
        background: radial-gradient(500px 300px at 50% -20%, #24381f, #0a0a12 70%);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e0e0e0;
      }
      img { width: 96px; height: 96px; }
      h1 { font-size: 34px; letter-spacing: 0.02em; }
      p { font-size: 14px; color: #9db89d; }
    </style></head><body>
      <img src="data:image/png;base64,${icon}" alt="">
      <h1>Bark</h1>
      <p>Remote Nostr signing. No keys in the browser.</p>
    </body></html>`)
    await tile.screenshot({ path: path.join(outDir, 'promo-tile-440x280.png') })
    console.log('captured promo-tile-440x280.png')
    await tile.close()
  }
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}

console.log('done —', outDir)
