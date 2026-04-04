// Background service worker — handles NIP-46 relay communication with Heartwood.

import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { evaluatePolicy, DEFAULT_POLICIES } from './policy.js'

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
const BUNKER_URI_RE = /^bunker:\/\/[0-9a-f]{64}(\?[/\w:.=&%-]+)?$/

// ---------------------------------------------------------------------------
// Multi-instance storage helpers
// ---------------------------------------------------------------------------

/** Extract the bunker pubkey (first 8 hex chars) from a bunker URI. */
function bunkerPubkeyPrefix(uri) {
  const match = uri.match(/^bunker:\/\/([0-9a-f]{8})/)
  return match ? match[1] : 'unknown'
}

/** Build a stable instance ID from a name and bunker URI. */
export function makeInstanceId(name, bunkerUri) {
  return `${name}-${bunkerPubkeyPrefix(bunkerUri)}`
}

/**
 * Migrate legacy single-connection storage to multi-instance format.
 * Returns { instances, activeInstanceId, removeKeys } or null if no migration needed.
 */
export function migrateStorage(stored) {
  if (stored.instances || !stored.bunkerUri) return null
  const id = makeInstanceId('legacy', stored.bunkerUri)
  return {
    instances: [{
      id,
      name: 'legacy',
      address: '',
      bunkerUri: stored.bunkerUri,
      clientSecret: stored.clientSecret || '',
      npub: '',
      signingPubkey: '',
      isHeartwood: stored.isHeartwood || false,
    }],
    activeInstanceId: id,
    removeKeys: ['bunkerUri', 'clientSecret', 'isHeartwood'],
  }
}

/** Normalise a Heartwood address: ensure scheme, strip trailing slash. */
export function normaliseAddress(addr) {
  let url = addr.trim()
  if (!/^https?:\/\//.test(url)) url = `http://${url}`
  url = url.replace(/\/+$/, '')
  try { new URL(url) } catch { throw new Error('Invalid address.') }
  return url
}

/**
 * Load policies from storage, falling back to defaults.
 * @returns {Promise<import('./policy.js').PolicySet>}
 */
async function loadPolicies() {
  if (typeof chrome === 'undefined' || !chrome.storage) return DEFAULT_POLICIES
  const { policies } = await chrome.storage.local.get('policies')
  return policies || DEFAULT_POLICIES
}

/**
 * Check whether a request requires approval, is denied, or is allowed.
 * Exported for testing — in tests, uses DEFAULT_POLICIES (no chrome.storage).
 *
 * @param {string} method
 * @param {*} params
 * @param {string} [origin]
 * @returns {Promise<'allow'|'ask'|'deny'>}
 */
export async function checkApproval(method, params, origin) {
  const policies = await loadPolicies()
  return evaluatePolicy(policies, method, params, origin)
}

/** Timeout for approval requests (ms). */
const APPROVAL_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Approval system — pending requests awaiting user decision
// ---------------------------------------------------------------------------

/** @type {Map<string, { method: string, params: any, event?: object, pubkey: string, personaName: string, origin: string, instanceId?: string, sendResponse: Function, timeoutId: number, windowId?: number }>} */
const pendingApprovals = new Map()

/** @type {string|null} Currently active approval request ID, if any. */
let activeApprovalId = null


/**
 * Open the approval popup window and store the pending request.
 */
async function openApprovalWindow(requestId, details) {
  const timeoutId = setTimeout(() => {
    denyApproval(requestId, 'Approval timed out.')
  }, APPROVAL_TIMEOUT_MS)

  pendingApprovals.set(requestId, { ...details, timeoutId })
  activeApprovalId = requestId

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approve.html?requestId=${requestId}`),
      type: 'popup',
      width: 420,
      height: 520,
      focused: true,
    })
    const entry = pendingApprovals.get(requestId)
    if (entry) entry.windowId = win.id
  } catch (err) {
    denyApproval(requestId, 'Could not open approval window.')
  }
}

/**
 * Deny a pending approval — resolve the original request with an error.
 */
function denyApproval(requestId, reason) {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return
  clearTimeout(entry.timeoutId)
  pendingApprovals.delete(requestId)
  if (activeApprovalId === requestId) activeApprovalId = null
  entry.sendResponse({ error: reason || 'Request denied by user.' })
}

/**
 * Allow a pending approval — execute the original request.
 */
async function allowApproval(requestId) {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return
  clearTimeout(entry.timeoutId)
  pendingApprovals.delete(requestId)
  if (activeApprovalId === requestId) activeApprovalId = null

  // Verify the active instance hasn't changed since the approval was created
  if (entry.instanceId) {
    const { activeInstanceId } = await chrome.storage.local.get('activeInstanceId')
    if (entry.instanceId !== activeInstanceId) {
      entry.sendResponse({ error: 'Active identity changed. Please retry.' })
      return
    }
  }

  try {
    const result = await handleMessage(entry.method, entry.params)
    entry.sendResponse(result)
  } catch (err) {
    entry.sendResponse({ error: sanitiseError(err) })
  }
}

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
  return typeof value === 'string' && value.length <= 2048 && BUNKER_URI_RE.test(value)
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
// Auto-reconnect with exponential backoff
// ---------------------------------------------------------------------------

const RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000]
let reconnectAttempt = 0
let reconnectTimer = null

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
  reconnectAttempt++
  console.error(`[bark:bg] reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureConnected().catch(() => {})
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

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
/**
 * Check whether the BunkerSigner's relay pool has any live connections.
 * MV3 service workers kill WebSockets when idle, so the pool can be
 * silently dead even though the signer object still exists.
 */
function isPoolAlive() {
  if (!signer?.pool?.relays) {
    console.error('[bark:bg] isPoolAlive: no pool or relays')
    return false
  }
  const relayMap = signer.pool.relays
  if (relayMap.size === 0) {
    console.error('[bark:bg] isPoolAlive: relay map is empty')
    return false
  }
  let alive = false
  relayMap.forEach((relay, url) => {
    const wsState = relay?.ws?.readyState
    const connected = relay?.connected
    console.error('[bark:bg] isPoolAlive:', url, 'connected:', connected, 'ws.readyState:', wsState)
    if (connected || wsState === 1) alive = true
  })
  if (!alive) console.error('[bark:bg] isPoolAlive: no live relays')
  return alive
}

async function ensureConnected() {
  // If we have a signer but the relay pool is dead, tear it down so
  // doConnect() creates a fresh one with live WebSocket connections.
  if (signer && !isPoolAlive()) {
    console.error('[bark:bg] pool connections dead — forcing reconnect')
    try { signer.close() } catch { /* ignore */ }
    signer = null
  }
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

  // Migrate legacy single-connection storage on first run
  const stored = await chrome.storage.local.get(null)
  const migration = migrateStorage(stored)
  if (migration) {
    await chrome.storage.local.set({
      instances: migration.instances,
      activeInstanceId: migration.activeInstanceId,
    })
    await chrome.storage.local.remove(migration.removeKeys)
    console.log('[bark] Migrated legacy storage to multi-instance format')
  }

  // Read multi-instance state
  const { instances = [], activeInstanceId } = await chrome.storage.local.get([
    'instances',
    'activeInstanceId',
  ])
  const active = instances.find(i => i.id === activeInstanceId)
  if (!active) {
    connectionState.status = 'disconnected'
    throw new Error('No Heartwood instance configured. Open the Bark popup to connect.')
  }

  const bunkerUri = active.bunkerUri
  const clientSecret = active.clientSecret

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
    active.clientSecret = bytesToHex(clientSk)
    await chrome.storage.local.set({ instances })
  }

  signer = BunkerSigner.fromBunker(clientSk, bp, {
    onauth(authUrl) {
      connectionState.status = 'awaiting-approval'
      connectionState.lastError = 'Approve this client on your Heartwood device.'
      connectionState.authUrl = authUrl || null
    },
  })

  try {
    // Allow relay WebSocket connections to establish before sending the
    // connect request. Without this, the subscription may not be ready
    // when the bunker responds, causing a missed response and timeout.
    await new Promise(r => setTimeout(r, 2000))

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
    scheduleReconnect()
    await probeRelays(bp.relays)
    throw err
  }

  cancelReconnect()
  connectionState.status = 'connected'
  connectionState.lastError = null

  // Probe relay health
  await probeRelays(bp.relays)

  // Detect Heartwood mode and approval status.
  try {
    await signer.sendRequest('heartwood_list_identities', [])
    connectionState.isHeartwood = true
  } catch (err) {
    const msg = String(err?.message || err || '')
    if (msg.includes('not approved')) {
      // Connected to Heartwood but client needs approval
      connectionState.isHeartwood = true
      connectionState.status = 'awaiting-approval'
      connectionState.lastError = 'Approve this client on your Heartwood device.'
    } else {
      // Only mark as non-Heartwood if the bunker explicitly rejects the method
      const isMethodRejection = msg.includes('unknown method')
        || msg.includes('not supported')
        || msg.includes('unrecognised')
        || msg.includes('unrecognized')
      connectionState.isHeartwood = !isMethodRejection
    }
  }
  await chrome.storage.local.set({ isHeartwood: connectionState.isHeartwood })

  return signer
}

/**
 * Tear down the current connection (used by bark-reset).
 */
async function resetConnection() {
  cancelReconnect()
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
  console.error('[bark:bg] handleMessage', parsed.type, parsed.method, 'connecting...')
  const bunker = await ensureConnected()
  console.error('[bark:bg] handleMessage', parsed.type, parsed.method, 'connected, dispatching')

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
        console.error('[bark:bg] signEvent: calling bunker.signEvent()...')
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
      // After a switch, clear the cached pubkey so getPublicKey() fetches
      // the new active identity from the bunker.
      if (parsed.method === 'heartwood_switch') {
        bunker.cachedPubKey = null
      }
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
      if (!params || typeof params.target !== 'string' || params.target.length === 0 || params.target.length > 256) {
        throw new Error('heartwood_switch requires a target (npub, persona name, purpose, or "master").')
      }
      return [params.target]
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
  'No Heartwood instance',
  'Invalid bunker URI',
  'Invalid address',
  'Bunker URI must',
  'Connection timed out',
  'Invalid method',
  'signEvent requires',
  'nip44.',
  'heartwood_',
  'Unknown method',
  'Corrupted client',
  'Approve this client',
  'client not approved',
  'Active identity changed',
  'Instance not found',
  'Server returned',
  'Request denied',
  'An approval request',
  'Approval timed out',
  'Could not open approval',
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

if (typeof chrome !== 'undefined' && chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    for (const [requestId, entry] of pendingApprovals) {
      if (entry.windowId === windowId) {
        denyApproval(requestId, 'Request denied by user.')
        break
      }
    }
  })
}

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

    if (message.type === 'bark-pair') {
      const { address } = message;
      (async () => {
        try {
          const { instances = [] } = await chrome.storage.local.get('instances')
          let bunkerUri, instanceName, npub, pairAddress

          if (address.startsWith('bunker://')) {
            // Direct bunker URI — skip HTTP pairing, connect via NIP-46 only.
            // Works from anywhere (no local network needed).
            if (!isValidBunkerUri(address)) {
              throw new Error('Invalid bunker URI format.')
            }
            bunkerUri = address
            instanceName = 'bunker'
            npub = ''
            pairAddress = address
          } else {
            // HTTP pairing — fetch bunker URI from the device web API.
            const url = normaliseAddress(address)
            pairAddress = url

            const existing = instances.find(i => i.address === url)
            const clientSk = existing && existing.clientSecret && /^[0-9a-f]{64}$/.test(existing.clientSecret)
              ? hexToBytes(existing.clientSecret)
              : generateSecretKey()
            const clientPk = getPublicKey(clientSk)

            const res = await fetch(`${url}/api/pair`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: 'bark', pubkey: clientPk }),
            })

            if (!res.ok) {
              const body = await res.json().catch(() => ({}))
              throw new Error(body.error || `HTTP ${res.status}`)
            }

            const data = await res.json()

            if (!data.bunkerUri || !isValidBunkerUri(data.bunkerUri)) {
              throw new Error('Server returned an invalid bunker URI.')
            }
            if (data.instance && (typeof data.instance !== 'string' || data.instance.length > 64)) {
              throw new Error('Server returned an invalid instance name.')
            }

            bunkerUri = data.bunkerUri
            instanceName = data.instance || 'heartwood'
            npub = data.npub || ''

            // Save client secret for HTTP-paired instances
            const id = makeInstanceId(instanceName, bunkerUri)
            if (existing) {
              existing.bunkerUri = bunkerUri
              existing.npub = npub || existing.npub
              existing.name = instanceName || existing.name
              existing.id = id
            } else {
              instances.push({
                id,
                name: instanceName,
                address: url,
                bunkerUri,
                clientSecret: bytesToHex(clientSk),
                npub,
                signingPubkey: '',
                isHeartwood: true,
              })
            }
            await chrome.storage.local.set({ instances, activeInstanceId: id })
            signer = null
            connectPromise = null
            sendResponse({ ok: true })
            ensureConnected().catch(() => {})
            return
          }

          // Direct bunker URI path — generate a fresh client key and store.
          const existing = instances.find(i => i.bunkerUri === bunkerUri)
          const clientSk = existing && existing.clientSecret && /^[0-9a-f]{64}$/.test(existing.clientSecret)
            ? hexToBytes(existing.clientSecret)
            : generateSecretKey()

          const id = makeInstanceId(instanceName, bunkerUri)

          if (existing) {
            existing.bunkerUri = bunkerUri
            existing.name = instanceName
            existing.id = id
          } else {
            instances.push({
              id,
              name: instanceName,
              address: pairAddress,
              bunkerUri,
              clientSecret: bytesToHex(clientSk),
              npub,
              signingPubkey: '',
              isHeartwood: false,
            })
          }

          await chrome.storage.local.set({ instances, activeInstanceId: id })

          signer = null
          connectPromise = null
          sendResponse({ ok: true })
          ensureConnected().catch(() => {})
        } catch (err) {
          sendResponse({ ok: false, error: sanitiseError(err) })
        }
      })()
      return true
    }

    if (message.type === 'bark-switch') {
      const { instanceId } = message;
      (async () => {
        try {
          const { instances = [] } = await chrome.storage.local.get('instances')
          const target = instances.find(i => i.id === instanceId)
          if (!target) throw new Error('Instance not found.')

          if (signer) {
            try { signer.close() } catch {}
            signer = null
          }
          connectPromise = null
          connectionState.status = 'connecting'

          await chrome.storage.local.set({ activeInstanceId: instanceId })

          // Respond immediately — connect in the background
          sendResponse({ ok: true })
          ensureConnected().catch(() => {})
        } catch (err) {
          sendResponse({ ok: false, error: sanitiseError(err) })
        }
      })()
      return true
    }

    if (message.type === 'bark-remove') {
      const { instanceId } = message;
      (async () => {
        try {
          let { instances = [], activeInstanceId } = await chrome.storage.local.get([
            'instances',
            'activeInstanceId',
          ])
          instances = instances.filter(i => i.id !== instanceId)

          if (activeInstanceId === instanceId) {
            if (signer) {
              try { signer.close() } catch {}
              signer = null
            }
            connectPromise = null
            activeInstanceId = instances.length > 0 ? instances[0].id : null
            connectionState.status = instances.length > 0 ? 'connecting' : 'disconnected'
          }

          await chrome.storage.local.set({ instances, activeInstanceId })

          if (instances.length > 0 && activeInstanceId) {
            await ensureConnected()
          }

          sendResponse({ ok: true, remaining: instances.length })
        } catch (err) {
          sendResponse({ ok: false, error: sanitiseError(err) })
        }
      })()
      return true
    }

    if (message.type === 'bark-approval-query') {
      const entry = pendingApprovals.get(message.requestId)
      if (!entry) {
        sendResponse(null)
        return true
      }
      sendResponse({
        method: entry.method,
        event: entry.event || null,
        pubkey: entry.pubkey,
        personaName: entry.personaName,
        origin: entry.origin,
      })
      return true
    }

    if (message.type === 'bark-approval-response') {
      const { requestId: rid, decision } = message
      if (decision === 'allow') {
        allowApproval(rid)
      } else {
        denyApproval(rid, 'Request denied by user.')
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'bark-request') {
      console.error('[bark:bg] ← request', message.method, 'from', sender.tab ? 'tab' : 'extension');
      (async () => {
        // Extension-internal requests (e.g. from popup) bypass policy checks.
        if (!sender.tab) {
          try {
            const result = await handleMessage(message.method, message.params)
            console.error('[bark:bg] → response', message.method, typeof result === 'string' ? result.slice(0, 40) : typeof result)
            sendResponse(result)
          } catch (err) {
            console.error('[bark:bg] ✗ error', message.method, sanitiseError(err))
            sendResponse({ error: sanitiseError(err) })
          }
          return
        }

        const origin = sender.origin || sender.tab?.url
        const decision = await checkApproval(message.method, message.params, origin)

        if (decision === 'deny') {
          console.error('[bark:bg] request denied by policy for', message.method)
          sendResponse({ error: 'Request denied by policy.' })
          return
        }

        if (decision === 'ask') {
          console.error('[bark:bg] approval required for', message.method)
          // Guard: only one approval at a time
          if (activeApprovalId) {
            sendResponse({ error: 'An approval request is already in progress.' })
            return
          }

          const requestId = `approval-${crypto.randomUUID()}`

          try {
            const bunker = await ensureConnected()
            const pubkey = await bunker.getPublicKey()

            // For Heartwood, try to get the active persona name
            let personaName = 'default'
            if (connectionState.isHeartwood) {
              try {
                const raw = await bunker.sendRequest('heartwood_list_identities', [])
                const identities = JSON.parse(raw)
                if (Array.isArray(identities)) {
                  const match = identities.find((id) => (id.pubkey || id.npub) === pubkey)
                  personaName = match?.name || match?.personaName || match?.purpose || 'default'
                }
              } catch { /* use default */ }
            }

            const { activeInstanceId: approvalInstanceId } = await chrome.storage.local.get('activeInstanceId')

            await openApprovalWindow(requestId, {
              method: message.method,
              params: message.params,
              event: message.method === 'signEvent' ? message.params : undefined,
              pubkey,
              personaName,
              instanceId: approvalInstanceId,
              origin: origin || 'Unknown',
              sendResponse,
            })
          } catch (err) {
            sendResponse({ error: sanitiseError(err) })
          }
          return
        }

        // decision === 'allow'
        try {
          const result = await handleMessage(message.method, message.params)
          console.error('[bark:bg] → response', message.method, typeof result === 'string' ? result.slice(0, 40) : typeof result)
          sendResponse(result)
        } catch (err) {
          console.error('[bark:bg] ✗ error', message.method, sanitiseError(err))
          sendResponse({ error: sanitiseError(err) })
        }
      })()
      return true // keep channel open for async response
    }
  })
}
