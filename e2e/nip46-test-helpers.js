import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { buildTrustedSiteRule, DEFAULT_POLICIES } from '../src/policy.js'

const NOSTR_CONNECT_KIND = 24133
const SIGNER_SECRET_HEX = '22'.repeat(32)
export const CLIENT_SECRET_HEX = '11'.repeat(32)
const BUNKER_SECRET = 'deterministic-local-relay-secret'

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

export function diagnosticUrl(extensionId) {
  return `chrome-extension://${extensionId}/diagnostic.html`
}

export async function withTestPage(fn, {
  title = 'Bark E2E',
  body = 'Bark E2E host page',
} = {}) {
  const sockets = new Set()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html>
      <html>
        <head><title>${title}</title></head>
        <body><main id="app">${body}</main></body>
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

export async function runtimeMessage(context, extensionId, message, timeoutMs = 30_000) {
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

export async function readExtensionStorage(context, extensionId, keys = null) {
  const extensionPage = await context.newPage()
  try {
    await extensionPage.goto(diagnosticUrl(extensionId), {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    })
    return await extensionPage.evaluate((storageKeys) => new Promise((resolve, reject) => {
      chrome.storage.local.get(storageKeys, (result) => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(result)
      })
    }), keys)
  } finally {
    await extensionPage.close()
  }
}

export async function seedDeterministicSigner({
  context,
  extensionId,
  origin,
  bunkerUri,
  trustedOrigin = true,
  instanceId = 'deterministic-nip46',
  instanceName = 'deterministic local signer',
}) {
  const policies = {
    ...DEFAULT_POLICIES,
    siteRules: trustedOrigin && origin
      ? { [origin]: buildTrustedSiteRule() }
      : {},
  }

  const storage = {
    instances: [{
      id: instanceId,
      name: instanceName,
      address: 'local nip46 relay signer',
      bunkerUri,
      clientSecret: CLIENT_SECRET_HEX,
      npub: '',
      signingPubkey: '',
      signingVerifiedAt: 0,
      signingLastError: null,
      isHeartwood: false,
      connectOrigin: origin,
    }],
    activeInstanceId: instanceId,
    policies,
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

export async function callNostr(page, method, arg, timeoutMs = 30_000) {
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

export async function callNostrResult(page, method, arg, timeoutMs = 30_000) {
  return await page.evaluate(async ({ method, arg, timeout }) => {
    let request
    if (method === 'getPublicKey') request = window.nostr.getPublicKey()
    else if (method === 'getRelays') request = window.nostr.getRelays()
    else if (method === 'signEvent') request = window.nostr.signEvent(arg)
    else throw new Error(`Unknown test method: ${method}`)

    let timer
    try {
      return await Promise.race([
        request.then(
          result => ({ ok: true, result }),
          err => ({ ok: false, error: err?.message || String(err) }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve({ ok: false, error: `${method} timed out in page after ${timeout}ms` })
          }, timeout)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }, { method, arg, timeout: timeoutMs })
}

function eventMatchesFilter(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    const tagName = key.slice(1)
    const hasTag = event.tags?.some((tag) => tag[0] === tagName && values.includes(tag[1]))
    if (!hasTag) return false
  }

  if (filter.since && event.created_at < filter.since) return false
  if (filter.until && event.created_at > filter.until) return false
  return true
}

function eventMatchesFilters(filters, event) {
  return filters.some((filter) => eventMatchesFilter(filter, event))
}

function sendJson(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

export class DeterministicNip46Signer {
  constructor() {
    this.secretKey = hexToBytes(SIGNER_SECRET_HEX)
    this.pubkey = getPublicKey(this.secretKey)
    this.methods = []
    this.requests = []
    this.connections = new Set()
    this.wss = null
    this.relayUrl = ''
  }

  async start() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.wss.on('connection', (ws) => this.addConnection(ws))
    await new Promise((resolve) => this.wss.once('listening', resolve))
    const address = this.wss.address()
    this.relayUrl = `ws://127.0.0.1:${address.port}`
    return this
  }

  get bunkerUri() {
    const params = new URLSearchParams()
    params.append('relay', this.relayUrl)
    params.append('secret', BUNKER_SECRET)
    return `bunker://${this.pubkey}?${params.toString()}`
  }

  addConnection(ws) {
    ws.subscriptions = new Map()
    this.connections.add(ws)
    ws.on('message', (data) => this.handleWireMessage(ws, data.toString()))
    ws.on('close', () => this.connections.delete(ws))
  }

  handleWireMessage(ws, raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      sendJson(ws, ['NOTICE', 'invalid JSON'])
      return
    }

    if (!Array.isArray(message)) return
    const [type, ...args] = message
    if (type === 'REQ') {
      const [subscriptionId, ...filters] = args
      ws.subscriptions.set(subscriptionId, filters)
      sendJson(ws, ['EOSE', subscriptionId])
      return
    }

    if (type === 'CLOSE') {
      ws.subscriptions.delete(args[0])
      return
    }

    if (type === 'EVENT') {
      const event = args[0]
      if (!event?.id || !verifyEvent(event)) {
        sendJson(ws, ['OK', event?.id || '', false, 'invalid event'])
        return
      }
      sendJson(ws, ['OK', event.id, true, ''])
      this.publish(event)
      this.handleSignerRequest(event).catch((err) => {
        sendJson(ws, ['NOTICE', err?.message || String(err)])
      })
    }
  }

  publish(event) {
    for (const ws of this.connections) {
      for (const [subscriptionId, filters] of ws.subscriptions) {
        if (eventMatchesFilters(filters, event)) {
          sendJson(ws, ['EVENT', subscriptionId, event])
        }
      }
    }
  }

  async handleSignerRequest(event) {
    if (event.kind !== NOSTR_CONNECT_KIND) return
    if (!event.tags?.some((tag) => tag[0] === 'p' && tag[1] === this.pubkey)) return

    const conversationKey = getConversationKey(this.secretKey, event.pubkey)
    const request = JSON.parse(decrypt(event.content, conversationKey))
    this.methods.push(request.method)
    this.requests.push(request)

    const response = this.handleRequest(request)
    const content = encrypt(JSON.stringify({
      id: request.id,
      ...response,
    }), conversationKey)

    const responseEvent = finalizeEvent({
      kind: NOSTR_CONNECT_KIND,
      tags: [['p', event.pubkey]],
      content,
      created_at: Math.floor(Date.now() / 1000),
    }, this.secretKey)
    this.publish(responseEvent)
  }

  /**
   * Act as the signer in a client-initiated nostrconnect flow: decrypt the
   * URI parameters and publish the connect ack (the secret) to the client.
   * Safe to call repeatedly while waiting for the client's subscription.
   */
  acceptNostrConnect(uri) {
    const parsed = new URL(uri)
    const clientPubkey = parsed.hostname || parsed.host
    const secret = parsed.searchParams.get('secret')
    const conversationKey = getConversationKey(this.secretKey, clientPubkey)
    const content = encrypt(JSON.stringify({
      id: `nostrconnect-ack-${Date.now()}`,
      result: secret,
    }), conversationKey)
    const responseEvent = finalizeEvent({
      kind: NOSTR_CONNECT_KIND,
      tags: [['p', clientPubkey]],
      content,
      created_at: Math.floor(Date.now() / 1000),
    }, this.secretKey)
    this.publish(responseEvent)
  }

  handleRequest(request) {
    if (request.method === 'connect') {
      const [remotePubkey, secret] = request.params || []
      if (remotePubkey !== this.pubkey) return { error: 'wrong remote signer pubkey' }
      if (secret !== BUNKER_SECRET) return { error: 'bad bunker secret' }
      return { result: 'ack' }
    }

    if (request.method === 'get_public_key') {
      return { result: this.pubkey }
    }

    if (request.method === 'sign_event') {
      const [rawEvent] = request.params || []
      const template = JSON.parse(rawEvent)
      return { result: JSON.stringify(finalizeEvent(template, this.secretKey)) }
    }

    if (request.method === 'get_relays') {
      return { result: JSON.stringify([this.relayUrl]) }
    }

    if (request.method === 'ping') {
      return { result: 'pong' }
    }

    if (request.method === 'nip44_encrypt' || request.method === 'nip44_decrypt') {
      const [thirdPartyPubkey, text] = request.params || []
      if (!/^[0-9a-f]{64}$/.test(thirdPartyPubkey || '')) return { error: 'bad third-party pubkey' }
      const conversationKey = getConversationKey(this.secretKey, thirdPartyPubkey)
      return {
        result: request.method === 'nip44_encrypt'
          ? encrypt(text, conversationKey)
          : decrypt(text, conversationKey),
      }
    }

    return { error: 'unsupported method' }
  }

  async close() {
    for (const ws of this.connections) ws.close()
    this.connections.clear()
    if (!this.wss) return
    await new Promise((resolve, reject) => {
      this.wss.close((err) => err ? reject(err) : resolve())
    })
    this.wss = null
  }
}

export async function withDeterministicNip46Signer(fn) {
  const signer = await new DeterministicNip46Signer().start()
  try {
    return await fn(signer)
  } finally {
    await signer.close()
  }
}
