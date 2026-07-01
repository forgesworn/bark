import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { buildTrustedSiteRule, DEFAULT_POLICIES } from '../src/policy.js'
import { test, expect } from './extension.fixture.js'

const liveBunkerUri = process.env.BARK_LIVE_BUNKER_URI
const liveClientSecret = process.env.BARK_LIVE_CLIENT_SECRET

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

function diagnosticUrl(extensionId) {
  return `chrome-extension://${extensionId}/diagnostic.html`
}

async function withTestPage(fn) {
  const sockets = new Set()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html>
      <html>
        <head><title>Bark Live Relay E2E</title></head>
        <body><main id="app">Bark Live Relay E2E host page</main></body>
      </html>`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', resolve)
  })

  const address = server.address()
  const url = `http://localhost:${address.port}/`

  try {
    return await fn(url)
  } finally {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }
}

function targetPubkeyFromBunkerUri(uri) {
  const match = /^bunker:\/\/([0-9a-f]{64})(?:[/?#]|$)/.exec(uri)
  if (!match) throw new Error('BARK_LIVE_BUNKER_URI must be a valid bunker:// URI with a 64-hex pubkey.')
  return match[1]
}

function testClientSecret() {
  if (!liveClientSecret) return randomBytes(32).toString('hex')
  if (!/^[0-9a-f]{64}$/.test(liveClientSecret)) {
    throw new Error('BARK_LIVE_CLIENT_SECRET must be a 64-character lowercase hex secret key.')
  }
  return liveClientSecret
}

async function seedLiveSigner({ context, extensionId, origin, bunkerUri }) {
  const targetPubkey = targetPubkeyFromBunkerUri(bunkerUri)
  const id = `live-relay-${targetPubkey.slice(0, 8)}`
  const storage = {
    instances: [{
      id,
      name: 'live-relay',
      address: 'live relay signer',
      bunkerUri,
      clientSecret: testClientSecret(),
      npub: '',
      signingPubkey: '',
      signingVerifiedAt: 0,
      signingLastError: null,
      isHeartwood: false,
      connectOrigin: origin,
    }],
    activeInstanceId: id,
    policies: {
      ...DEFAULT_POLICIES,
      siteRules: {
        [origin]: buildTrustedSiteRule(),
      },
    },
  }

  const extensionPage = await context.newPage()
  try {
    await extensionPage.goto(diagnosticUrl(extensionId), {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    })
    await extensionPage.evaluate((nextStorage) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('chrome.storage.local seed timed out'))
      }, 10_000)

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

function summariseStatus(status) {
  if (!status || typeof status !== 'object') return status
  return {
    status: status.status,
    lastError: status.lastError,
    isHeartwood: status.isHeartwood,
    signingStatus: status.signingStatus,
    signingLastError: status.signingLastError,
    relays: Array.isArray(status.relays)
      ? status.relays.map((relay) => ({
          url: relay.url,
          connected: !!relay.connected,
        }))
      : [],
  }
}

async function runtimeMessage(context, extensionId, message, timeoutMs = 30_000) {
  const extensionPage = await context.newPage()
  try {
    await extensionPage.goto(diagnosticUrl(extensionId), {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    })
    const response = await extensionPage.evaluate(({ payload, timeout }) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ __timeout: true })
      }, timeout)

      chrome.runtime.sendMessage(payload, (result) => {
        clearTimeout(timer)
        const err = chrome.runtime.lastError
        if (err) resolve({ error: err.message })
        else resolve(result)
      })
    }), { payload: message, timeout: timeoutMs })

    if (response?.__timeout) throw new Error(`runtime message timed out after ${timeoutMs}ms`)
    return response
  } finally {
    await extensionPage.close()
  }
}

async function barkStatus(context, extensionId) {
  try {
    return summariseStatus(await runtimeMessage(context, extensionId, { type: 'bark-status' }, 5_000))
  } catch (err) {
    return { statusReadError: err?.message || String(err) }
  }
}

async function withDiagnostics(label, context, extensionId, action, timeoutMs = 45_000) {
  let timer
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } catch (err) {
    const status = await barkStatus(context, extensionId)
    throw new Error(`${label} failed: ${err?.message || String(err)}; Bark status: ${JSON.stringify(status)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function callNostr(page, method, arg, timeoutMs = 35_000) {
  return await page.evaluate(async ({ method, arg, timeout }) => {
    let request
    if (method === 'getPublicKey') request = window.nostr.getPublicKey()
    else if (method === 'getRelays') request = window.nostr.getRelays()
    else if (method === 'signEvent') request = window.nostr.signEvent(arg)
    else throw new Error(`Unknown test method: ${method}`)

    let timer
    try {
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out in page after ${timeout}ms`)), timeout)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }, { method, arg, timeout: timeoutMs })
}

test.describe('live relay signer smoke', () => {
  test.skip(!liveBunkerUri, 'Set BARK_LIVE_BUNKER_URI to run the live relay signer smoke.')

  test('gets a pubkey and signs through the configured relay signer', async ({ context, extensionId }) => {
    test.setTimeout(180_000)

    await withTestPage(async (url) => {
      let page
      try {
        console.log('[bark live] test page ready')
        const origin = new URL(url).origin
        console.log('[bark live] seeding storage')
        await withDiagnostics(
          'seed live signer storage',
          context,
          extensionId,
          () => seedLiveSigner({
            context,
            extensionId,
            origin,
            bunkerUri: liveBunkerUri,
          }),
          20_000,
        )
        console.log('[bark live] storage seeded')

        console.log('[bark live] priming background signer')
        const primeResult = await withDiagnostics(
          'background signer prime',
          context,
          extensionId,
          async () => {
            const response = await runtimeMessage(context, extensionId, {
              type: 'bark-prime-signer',
            }, 60_000)
            if (response?.error) throw new Error(response.error)
            if (!response?.ok) throw new Error(response?.error || 'Signer prime failed.')
            return response
          },
          65_000,
        )
        const directPubkey = primeResult.pubkey
        expect(directPubkey).toMatch(/^[0-9a-f]{64}$/)
        console.log('[bark live] background signer prime ok')

        console.log('[bark live] opening host page')
        page = await context.newPage()
        await page.goto(url)

        console.log('[bark live] waiting for provider')
        await expect.poll(async () => {
          return await page.evaluate(() => typeof window.nostr?.getPublicKey)
        }).toBe('function')
        console.log('[bark live] provider ready')

        console.log('[bark live] calling window.nostr.getPublicKey')
        const pubkey = await withDiagnostics(
          'window.nostr.getPublicKey',
          context,
          extensionId,
          () => callNostr(page, 'getPublicKey'),
        )
        expect(pubkey).toMatch(/^[0-9a-f]{64}$/)
        expect(pubkey).toBe(directPubkey)
        console.log('[bark live] window.nostr.getPublicKey ok')

        console.log('[bark live] calling window.nostr.getRelays')
        const relays = await withDiagnostics(
          'window.nostr.getRelays',
          context,
          extensionId,
          () => callNostr(page, 'getRelays'),
        )
        const relayUrls = Object.keys(relays)
        expect(relayUrls.length).toBeGreaterThan(0)
        expect(relayUrls.every((relay) => relay.startsWith('wss://'))).toBe(true)
        console.log('[bark live] window.nostr.getRelays ok')

        const template = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['client', 'bark-live-e2e']],
          content: `bark live relay smoke ${Date.now()}`,
        }

        console.log('[bark live] calling window.nostr.signEvent')
        const signed = await withDiagnostics(
          'window.nostr.signEvent',
          context,
          extensionId,
          () => callNostr(page, 'signEvent', template, 55_000),
          60_000,
        )

        expect(signed).toMatchObject({
          kind: template.kind,
          content: template.content,
          pubkey,
        })
        expect(signed.id).toMatch(/^[0-9a-f]{64}$/)
        expect(signed.sig).toMatch(/^[0-9a-f]{128}$/)
        expect(verifyEvent(signed)).toBe(true)
        console.log('[bark live] window.nostr.signEvent ok')
      } finally {
        console.log('[bark live] cleanup start')
        if (page) {
          await Promise.race([
            page.close(),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ])
        }
        await Promise.race([
          runtimeMessage(context, extensionId, { type: 'bark-reset' }, 5_000),
          new Promise((resolve) => setTimeout(resolve, 7_000)),
        ]).catch((err) => console.warn('[bark live] cleanup failed:', err?.message || String(err)))
        console.log('[bark live] cleanup done')
      }
    })
  })
})
