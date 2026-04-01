// Background service worker — handles NIP-46 relay communication with Heartwood.

import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

// ---------------------------------------------------------------------------
// Method parser — exported for unit testing
// ---------------------------------------------------------------------------

const NIP07_METHODS = new Set(['getPublicKey', 'signEvent'])

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
    return { type: 'nip44', method: method.slice('nip44.'.length) }
  }
  if (method.startsWith('heartwood_')) {
    return { type: 'heartwood', method }
  }
  return { type: 'unknown', method }
}

// ---------------------------------------------------------------------------
// NIP-46 connection state
// ---------------------------------------------------------------------------

/** @type {BunkerSigner|null} */
let signer = null

/**
 * Load persisted bunker URI and client secret from chrome.storage.local,
 * then establish the NIP-46 connection to Heartwood.
 */
async function ensureConnected() {
  if (signer) return signer

  const { bunkerUri, clientSecret } = await chrome.storage.local.get([
    'bunkerUri',
    'clientSecret',
  ])

  if (!bunkerUri) {
    throw new Error('No bunker URI configured. Open the Bark popup to connect.')
  }

  const bp = await parseBunkerInput(bunkerUri)

  // Re-use a persisted client secret so the bunker recognises us across
  // restarts, or generate a fresh one on first connection.
  let clientSk
  if (clientSecret) {
    clientSk = hexToBytes(clientSecret)
  } else {
    clientSk = generateSecretKey()
    await chrome.storage.local.set({ clientSecret: bytesToHex(clientSk) })
  }

  signer = BunkerSigner.fromBunker(clientSk, bp)
  await signer.connect()
  return signer
}

/**
 * Tear down the current connection (used by bark-reset).
 */
async function resetConnection() {
  signer = null
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
  const parsed = parseMethod(method)
  const bunker = await ensureConnected()

  switch (parsed.type) {
    case 'nip07': {
      if (parsed.method === 'getPublicKey') {
        return await bunker.getPublicKey()
      }
      if (parsed.method === 'signEvent') {
        return await bunker.signEvent(params)
      }
      break
    }

    case 'nip44': {
      if (parsed.method === 'encrypt') {
        return await bunker.nip44Encrypt(params.pubkey, params.plaintext)
      }
      if (parsed.method === 'decrypt') {
        return await bunker.nip44Decrypt(params.pubkey, params.ciphertext)
      }
      break
    }

    case 'heartwood': {
      // heartwood_list_identities -> sendRequest('heartwood_list_identities', [])
      // heartwood_derive          -> sendRequest('heartwood_derive', [purpose, index])
      // heartwood_switch          -> sendRequest('heartwood_switch', [pubkey])
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
function buildHeartwoodArgs(method, params) {
  switch (method) {
    case 'heartwood_list_identities':
      return []
    case 'heartwood_derive':
      return [params.purpose, String(params.index)]
    case 'heartwood_switch':
      return [params.pubkey]
    default:
      // Forward unknown heartwood methods with an empty arg list.
      return []
  }
}

// ---------------------------------------------------------------------------
// Chrome message listener — guarded so vitest can import this module
// ---------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'bark-reset') {
      resetConnection()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }))
      return true // keep channel open for async response
    }

    if (message.type === 'bark-request') {
      handleMessage(message.method, message.params)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }))
      return true // keep channel open for async response
    }
  })
}
