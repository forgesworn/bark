// Background service worker — handles NIP-46 relay communication with Heartwood.

import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for the initial NIP-46 connect handshake (ms). */
const CONNECT_TIMEOUT_MS = 30_000

/** Allowed NIP-07 methods. */
const NIP07_METHODS = new Set(['getPublicKey', 'signEvent'])

/** Allowed NIP-44 sub-methods (after the `nip44.` prefix). */
const NIP44_METHODS = new Set(['encrypt', 'decrypt'])

/** Allowed heartwood methods. */
const HEARTWOOD_METHODS = new Set([
  'heartwood_list_identities',
  'heartwood_derive',
  'heartwood_switch',
])

/** Regex for validating a bunker URI (bunker://<64-hex-chars>?<params>). */
const BUNKER_URI_RE = /^bunker:\/\/[0-9a-f]{64}\??[?/\w:.=&%-]*$/

// ---------------------------------------------------------------------------
// Method parser — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Classify an incoming method string into its handler category.
 * @param {string} method
 * @returns {{ type: 'nip07'|'nip44'|'heartwood'|'unknown', method: string }}
 */
export function parseMethod(method) {
  if (NIP07_METHODS.has(method)) {
    return { type: 'nip07', method }
  }
  if (method.startsWith('nip44.')) {
    const sub = method.slice('nip44.'.length)
    if (NIP44_METHODS.has(sub)) {
      return { type: 'nip44', method: sub }
    }
    return { type: 'unknown', method }
  }
  if (method.startsWith('heartwood_')) {
    if (HEARTWOOD_METHODS.has(method)) {
      return { type: 'heartwood', method }
    }
    return { type: 'unknown', method }
  }
  return { type: 'unknown', method }
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/** Validate that a value looks like a 64-character lowercase hex string. */
export function isValidHexPubkey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Validate a bunker URI matches the expected format. */
export function isValidBunkerUri(value) {
  return typeof value === 'string' && BUNKER_URI_RE.test(value)
}

/** Validate a purpose string for derivation (alphanumeric, hyphens, underscores, 1-64 chars). */
export function isValidPurpose(value) {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value)
}

// ---------------------------------------------------------------------------
// NIP-46 connection state
// ---------------------------------------------------------------------------

/** @type {BunkerSigner|null} */
let signer = null

/** @type {Promise<BunkerSigner>|null} Mutex to prevent concurrent connect attempts. */
let connectPromise = null

// ---------------------------------------------------------------------------
// Connection state — queried by popup via bark-status
// ---------------------------------------------------------------------------

/** @type {{ status: string, lastError: string|null, relays: Array<{url: string, connected: boolean}>, isHeartwood: boolean }} */
let connectionState = {
  status: 'disconnected',
  lastError: null,
  relays: [],
  isHeartwood: false,
}

/**
 * Probe each relay URL to determine which are currently reachable.
 * Uses the BunkerSigner's internal pool to check connection state.
 */
async function probeRelays(relayUrls) {
  if (!signer || relayUrls.length === 0) {
    connectionState.relays = relayUrls.map((url) => ({ url, connected: false }))
    return
  }
  connectionState.relays = await Promise.all(
    relayUrls.map(async (url) => {
      try {
        await signer.pool.ensureRelay(url, { connectionTimeout: 5000 })
        return { url, connected: true }
      } catch {
        return { url, connected: false }
      }
    }),
  )
}

/**
 * Load persisted bunker URI and client secret from chrome.storage.local,
 * then establish the NIP-46 connection to Heartwood.
 * Uses connectPromise as a mutex to prevent concurrent connection attempts.
 */
async function ensureConnected() {
  if (signer) return signer
  if (connectPromise) return connectPromise
  connectPromise = doConnect()
  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

async function doConnect() {

  connectionState.status = 'connecting'
  connectionState.lastError = null

  const { bunkerUri, clientSecret } = await chrome.storage.local.get([
    'bunkerUri',
    'clientSecret',
  ])

  if (!bunkerUri) {
    connectionState.status = 'disconnected'
    throw new Error('No bunker URI configured. Open the Bark popup to connect.')
  }

  if (!isValidBunkerUri(bunkerUri)) {
    connectionState.status = 'disconnected'
    throw new Error('Invalid bunker URI in storage.')
  }

  let bp
  try {
    bp = await parseBunkerInput(bunkerUri)
  } catch {
    connectionState.status = 'disconnected'
    throw new Error('Invalid bunker URI in storage.')
  }

  if (!bp || !bp.relays || bp.relays.length === 0) {
    connectionState.status = 'disconnected'
    throw new Error('Bunker URI must include at least one relay.')
  }

  let clientSk
  if (clientSecret) {
    if (typeof clientSecret !== 'string' || !/^[0-9a-f]{64}$/.test(clientSecret)) {
      connectionState.status = 'disconnected'
      throw new Error('Corrupted client secret in storage.')
    }
    clientSk = hexToBytes(clientSecret)
  } else {
    clientSk = generateSecretKey()
    await chrome.storage.local.set({ clientSecret: bytesToHex(clientSk) })
  }

  signer = BunkerSigner.fromBunker(clientSk, bp)

  try {
    await Promise.race([
      signer.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out.')), CONNECT_TIMEOUT_MS),
      ),
    ])
  } catch (err) {
    signer = null
    connectionState.status = 'disconnected'
    connectionState.lastError = sanitiseError(err)
    await probeRelays(bp.relays)
    throw err
  }

  connectionState.status = 'connected'
  connectionState.lastError = null

  // Probe relay health
  await probeRelays(bp.relays)

  // Detect Heartwood mode — only mark as non-Heartwood if the bunker
  // explicitly rejects the method. Transient errors (timeout, relay failure)
  // should not cause silent fallback to standard bunker mode.
  try {
    await signer.sendRequest('heartwood_list_identities', [])
    connectionState.isHeartwood = true
  } catch (err) {
    const msg = String(err?.message || err || '')
    const isMethodRejection = msg.includes('unknown method')
      || msg.includes('not supported')
      || msg.includes('unrecognised')
      || msg.includes('unrecognized')
    connectionState.isHeartwood = !isMethodRejection
  }
  await chrome.storage.local.set({ isHeartwood: connectionState.isHeartwood })

  return signer
}

/**
 * Tear down the current connection (used by bark-reset).
 */
async function resetConnection() {
  if (signer) {
    try { signer.close() } catch { /* ignore */ }
  }
  signer = null
  connectPromise = null
  connectionState.status = 'disconnected'
  connectionState.lastError = null
  connectionState.relays = []
  connectionState.isHeartwood = false
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

/**
 * Handle a classified request by delegating to the appropriate BunkerSigner
 * method.
 *
 * @param {string} method  Raw method string from the content script
 * @param {*}      params  Parameters accompanying the request
 * @returns {Promise<*>}
 */
async function handleMessage(method, params) {
  // Validate method is a string.
  if (typeof method !== 'string' || method.length === 0 || method.length > 64) {
    throw new Error('Invalid method.')
  }

  const parsed = parseMethod(method)
  const bunker = await ensureConnected()

  switch (parsed.type) {
    case 'nip07': {
      if (parsed.method === 'getPublicKey') {
        return await bunker.getPublicKey()
      }
      if (parsed.method === 'signEvent') {
        // Basic shape validation — the bunker will do full validation, but
        // reject obviously wrong payloads early.
        if (!params || typeof params !== 'object') {
          throw new Error('signEvent requires an event object.')
        }
        return await bunker.signEvent(params)
      }
      break
    }

    case 'nip44': {
      if (parsed.method === 'encrypt') {
        if (!params || typeof params.pubkey !== 'string' || typeof params.plaintext !== 'string') {
          throw new Error('nip44.encrypt requires pubkey and plaintext.')
        }
        if (!isValidHexPubkey(params.pubkey)) {
          throw new Error('Invalid pubkey for nip44.encrypt.')
        }
        return await bunker.nip44Encrypt(params.pubkey, params.plaintext)
      }
      if (parsed.method === 'decrypt') {
        if (!params || typeof params.pubkey !== 'string' || typeof params.ciphertext !== 'string') {
          throw new Error('nip44.decrypt requires pubkey and ciphertext.')
        }
        if (!isValidHexPubkey(params.pubkey)) {
          throw new Error('Invalid pubkey for nip44.decrypt.')
        }
        return await bunker.nip44Decrypt(params.pubkey, params.ciphertext)
      }
      break
    }

    case 'heartwood': {
      const args = buildHeartwoodArgs(parsed.method, params)
      const raw = await bunker.sendRequest(parsed.method, args)
      // sendRequest returns a JSON string; parse it for the caller.
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

/**
 * Map heartwood method params objects to the positional array that
 * BunkerSigner.sendRequest expects.
 */
export function buildHeartwoodArgs(method, params) {
  switch (method) {
    case 'heartwood_list_identities':
      return []
    case 'heartwood_derive': {
      if (!params || !isValidPurpose(params.purpose)) {
        throw new Error('heartwood_derive requires a valid purpose (alphanumeric, 1-64 chars).')
      }
      const index = Number(params.index)
      if (!Number.isInteger(index) || index < 0 || index > 1000) {
        throw new Error('heartwood_derive index must be an integer 0-1000.')
      }
      return [params.purpose, String(index)]
    }
    case 'heartwood_switch': {
      if (!params || !isValidHexPubkey(params.pubkey)) {
        throw new Error('heartwood_switch requires a valid hex pubkey.')
      }
      return [params.pubkey]
    }
    default:
      throw new Error(`Unknown heartwood method: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------------------

/**
 * Strip internal details from error messages before forwarding to content
 * scripts. Only whitelisted user-facing messages pass through; everything
 * else becomes a generic failure string.
 */
const SAFE_ERROR_PREFIXES = [
  'No bunker URI configured',
  'Invalid bunker URI',
  'Bunker URI must',
  'Connection timed out',
  'Invalid method',
  'signEvent requires',
  'nip44.',
  'heartwood_',
  'Unknown method',
  'Corrupted client',
]

export function sanitiseError(err) {
  // Handle both Error objects and plain strings (nostr-tools rejects NIP-46
  // errors as bare strings, not Error instances).
  const msg = typeof err === 'string' ? err : (err?.message || '')
  if (!msg) return 'Request failed.'
  for (const prefix of SAFE_ERROR_PREFIXES) {
    if (msg.startsWith(prefix)) return msg
  }
  return 'Request failed.'
}

// ---------------------------------------------------------------------------
// Chrome message listener — guarded so vitest can import this module
// ---------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only accept messages from our own extension context (content scripts
    // and the popup). Reject messages from other extensions or external
    // sources.
    if (sender.id !== chrome.runtime.id) return

    if (message.type === 'bark-status') {
      sendResponse({ ...connectionState })
      return true
    }

    if (message.type === 'bark-reset') {
      resetConnection()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: sanitiseError(err) }))
      return true // keep channel open for async response
    }

    if (message.type === 'bark-request') {
      handleMessage(message.method, message.params)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: sanitiseError(err) }))
      return true // keep channel open for async response
    }
  })
}
