// Generates the five store listing screenshots (1280×800) and the promo tile
// by driving the built extension through Playwright against the deterministic
// local NIP-46 signer, then composing each raw UI capture (taken at 2x device
// scale) into a captioned frame. Run `npm run build` first, then:
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

const FRAME = { width: 1280, height: 800 }
const iconB64 = readFileSync(path.resolve(__dirname, '..', 'src', 'icons', 'bark-128.png')).toString('base64')

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

/** Pin the extension page body to its natural popup width for a raw capture. */
async function rawStyle(page, width) {
  await page.addStyleTag({
    content: `body { width: ${width}px !important; margin: 0 !important; }`,
  })
}

async function openPopup(context, extensionId) {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' })
  await rawStyle(page, 320)
  return page
}

/** Capture a locator (or the whole body) as a raw PNG buffer at 2x scale. */
async function rawShot(page, selector = 'body') {
  await page.waitForTimeout(400)
  return await page.locator(selector).screenshot()
}

/**
 * Compose a raw UI capture into a 1280×800 store frame: headline and
 * supporting copy on the left, the capture (crisp 2x source, downscaled to
 * fit) on the right.
 */
async function compose(context, { name, headline, sub, raw, imageWidth = 500 }) {
  const page = await context.newPage()
  await page.setViewportSize(FRAME)
  await page.setContent(`<!doctype html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${FRAME.width}px; height: ${FRAME.height}px;
      display: flex; align-items: center; gap: 56px;
      padding: 0 72px;
      background: radial-gradient(1100px 640px at 72% -12%, #22371e, #0a0a12 62%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #eef4ee; overflow: hidden;
    }
    .copy { flex: 1; min-width: 0; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; }
    .brand img { width: 44px; height: 44px; }
    .brand span { font-size: 24px; font-weight: 700; letter-spacing: 0.02em; color: #cfe3cf; }
    h1 { font-size: 54px; line-height: 1.12; font-weight: 800; letter-spacing: -0.01em; margin-bottom: 22px; }
    p { font-size: 21px; line-height: 1.5; color: #9db89d; max-width: 460px; }
    .shot {
      flex: 0 0 auto; width: ${imageWidth}px;
      display: flex; align-items: center; justify-content: center;
    }
    .shot img {
      width: 100%; height: auto; max-height: ${FRAME.height - 96}px; object-fit: contain;
      border-radius: 14px;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7), 0 0 0 1px #2e2e3e;
    }
  </style></head><body>
    <div class="copy">
      <div class="brand"><img src="data:image/png;base64,${iconB64}" alt=""><span>Bark</span></div>
      <h1>${headline}</h1>
      <p>${sub}</p>
    </div>
    <div class="shot"><img src="data:image/png;base64,${raw.toString('base64')}" alt=""></div>
  </body></html>`)
  await page.waitForTimeout(200)
  // scale: 'css' keeps the file at exactly 1280×800 (the store's accepted
  // size) even though the context runs at deviceScaleFactor 2 so the
  // embedded raw UI capture stays crisp.
  await page.screenshot({ path: path.join(outDir, name), scale: 'css' })
  console.log('captured', name)
  await page.close()
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
  deviceScaleFactor: 2,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
  const extensionId = new URL(worker.url()).host

  await clearStorage(context, extensionId)

  // 01 — connected to a standard bunker, signing verified
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
    // Give the instance card a real npub instead of "connecting...".
    {
      const page = await context.newPage()
      await page.goto(`chrome-extension://${extensionId}/diagnostic.html`, { waitUntil: 'domcontentloaded' })
      await page.evaluate((npub) => new Promise((resolve) => {
        chrome.storage.local.get(['instances'], ({ instances }) => {
          instances[0].npub = npub
          chrome.storage.local.set({ instances }, resolve)
        })
      }), nip19.npubEncode(standardSigner.pubkey))
      await page.close()
    }
    const primed = await runtimeMessage(context, extensionId, { type: 'bark-prime-signer' }, 35_000)
    if (!primed?.ok) throw new Error(`prime failed: ${primed?.error}`)

    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#connected-content', { state: 'visible', timeout: 20_000 })
    await popup.waitForFunction(() => document.getElementById('sign-status-text')?.textContent === 'Signing ready', null, { timeout: 20_000 })
    await compose(context, {
      name: '01-connected.png',
      headline: 'No keys in the browser. Ever.',
      sub: 'Bark bridges window.nostr to your remote NIP-46 signer: a Heartwood device, your own heartwoodd bunker, or a hosted signer. Only signatures cross the wire.',
      raw: await rawShot(popup),
      imageWidth: 440,
    })
    await popup.close()
  }

  // 02 — approval window for an untrusted site's sign request
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
    await approval.waitForSelector('#content', { state: 'visible' })
    await rawStyle(approval, 420)
    await compose(context, {
      name: '02-approval.png',
      headline: 'Nothing signs without your say',
      sub: 'Every request from an unknown site asks first. Allow once, trust the site for routine signing, or deny. Concurrent requests queue with a toolbar badge.',
      raw: await rawShot(approval),
      imageWidth: 560,
    })

    await approval.getByRole('button', { name: 'Deny' }).click()
    await resultPromise
    await site.close()
  }, { title: 'Nostr web app', body: 'Demo Nostr web app' })

  // 03 — policy editor with per-site methods and privacy mode visible
  {
    await setStorage(context, extensionId, {
      policies: {
        ...DEFAULT_POLICIES,
        siteRules: {
          'https://snort.social': buildTrustedSiteRule(),
          'https://primal.net': buildTrustedSiteRule(),
        },
      },
      privacy: { enabled: true },
    })
    const popup = await openPopup(context, extensionId)
    await popup.waitForSelector('#connected-content', { state: 'visible', timeout: 20_000 })
    await popup.click('#policy-toggle')
    await popup.waitForSelector('#site-rules-list .policy-item')
    await popup.locator('#site-rules-list .policy-label', { hasText: 'snort.social' }).click()
    await popup.waitForSelector('.site-kind-panel')
    await compose(context, {
      name: '03-policies.png',
      headline: 'Policy control down to method and kind',
      sub: 'Per-site rules with per-method and per-kind overrides, protected kinds that always ask, and privacy mode that hides Bark from every unlisted site.',
      raw: await rawShot(popup, '#policy-section'),
      imageWidth: 460,
    })
    await popup.close()
  }
  await standardSigner.close()

  // 04 — QR pairing flow
  await clearStorage(context, extensionId)
  {
    const popup = await openPopup(context, extensionId)
    await popup.click('#qr-show-btn')
    await popup.click('#qr-start-btn')
    await popup.waitForSelector('#qr-code svg', { timeout: 10_000 })
    await compose(context, {
      name: '04-qr-pairing.png',
      headline: 'Pair by QR in seconds',
      sub: 'Bark generates a nostrconnect QR with a fresh key and secret. Scan it with your signer, or paste a bunker URI or Heartwood address instead.',
      raw: await rawShot(popup),
      imageWidth: 430,
    })
    await popup.click('#qr-cancel-btn')
    await popup.close()
  }

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
    await compose(context, {
      name: '05-personas.png',
      headline: 'One signer, many identities',
      sub: 'Heartwood devices derive unlimited personas from one seed. List, derive, and switch identities from the popup without exposing a single key.',
      raw: await rawShot(popup),
      imageWidth: 440,
    })
    await popup.close()
  }
  await heartwoodSigner.close()

  // Promo tile 440×280 (JPEG: the store rejects PNGs with an alpha channel)
  {
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
      <img src="data:image/png;base64,${iconB64}" alt="">
      <h1>Bark</h1>
      <p>Remote Nostr signing. No keys in the browser.</p>
    </body></html>`)
    await tile.screenshot({ path: path.join(outDir, 'promo-tile-440x280.jpg'), type: 'jpeg', quality: 92, scale: 'css' })
    console.log('captured promo-tile-440x280.jpg')
    await tile.close()
  }

  // Marquee promo tile 1400×560 (JPEG, no alpha)
  {
    const marquee = await context.newPage()
    await marquee.setViewportSize({ width: 1400, height: 560 })
    await marquee.setContent(`<!doctype html><html><head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        width: 1400px; height: 560px;
        display: flex; align-items: center; gap: 64px; padding: 0 110px;
        background: radial-gradient(1300px 700px at 78% -20%, #24381f, #0a0a12 62%);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #eef4ee;
      }
      img.logo { width: 200px; height: 200px; flex: 0 0 auto; }
      h1 { font-size: 76px; font-weight: 800; letter-spacing: -0.01em; margin-bottom: 14px; }
      p.tag { font-size: 30px; color: #9db89d; margin-bottom: 34px; }
      .chips { display: flex; gap: 14px; flex-wrap: wrap; }
      .chips span {
        font-size: 19px; color: #cfe3cf; background: rgba(51, 153, 51, 0.12);
        border: 1px solid #2e4a2e; border-radius: 999px; padding: 9px 20px;
      }
    </style></head><body>
      <img class="logo" src="data:image/png;base64,${iconB64}" alt="">
      <div>
        <h1>Bark</h1>
        <p class="tag">Sign Nostr events with keys that never touch the browser</p>
        <div class="chips">
          <span>Any NIP-46 bunker</span>
          <span>Per-site signing policies</span>
          <span>Privacy mode</span>
          <span>53 languages</span>
        </div>
      </div>
    </body></html>`)
    await marquee.screenshot({ path: path.join(outDir, 'marquee-promo-1400x560.jpg'), type: 'jpeg', quality: 92, scale: 'css' })
    console.log('captured marquee-promo-1400x560.jpg')
    await marquee.close()
  }
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}

console.log('done —', outDir)
