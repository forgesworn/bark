// Background service worker — handles NIP-46 relay communication with Heartwood.

import { BunkerSigner, parseBunkerInput, createNostrConnectURI, toBunkerURL } from 'nostr-tools/nip46'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import {
  buildTrustedSiteRule,
  evaluatePolicy,
  DEFAULT_POLICIES,
  normalisePolicies,
} from './policy.js'

const chrome = globalThis.browser || globalThis.chrome

const DEBUG = false
function debug(...args) {
  if (DEBUG) console.debug(...args)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for the initial NIP-46 connect handshake (ms). */
const CONNECT_TIMEOUT_MS = 30_000

/** Timeout for an established NIP-46 request (ms). */
const BUNKER_REQUEST_TIMEOUT_MS = 45_000

/** Timeout for optional Heartwood capability probing (ms). */
const HEARTWOOD_PROBE_TIMEOUT_MS = 5_000

/** Timeout for best-effort relay health probes (ms). */
const RELAY_PROBE_TIMEOUT_MS = 6_000

/** Allowed NIP-07 methods. */
const NIP07_METHODS = new Set(['getPublicKey', 'signEvent', 'getRelays'])

/** Allowed NIP-44 sub-methods (after the `nip44.` prefix). */
const NIP44_METHODS = new Set(['encrypt', 'decrypt'])

/** Allowed NIP-04 sub-methods (after the `nip04.` prefix). */
const NIP04_METHODS = new Set(['encrypt', 'decrypt'])

/** Allowed heartwood methods. */
const HEARTWOOD_METHODS = new Set([
  'heartwood_list_identities',
  'heartwood_derive',
  'heartwood_derive_persona',
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

/** Extract the full target pubkey from a bunker URI. */
function bunkerPubkey(uri) {
  const match = uri.match(/^bunker:\/\/([0-9a-f]{64})/)
  return match ? match[1] : ''
}

export function safeInstanceName(value, fallback = 'heartwood') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw
    .replace(/[^\w:.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned || fallback
}

/** Build a stable instance ID from a name and bunker URI. */
export function makeInstanceId(name, bunkerUri) {
  return `${safeInstanceName(name)}-${bunkerPubkeyPrefix(bunkerUri)}`
}

function identityLabel(identity, fallback = 'heartwood') {
  const candidates = [
    identity?.label,
    identity?.personaName,
    identity?.name,
    identity?.purpose,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return safeInstanceName(candidate, fallback)
    }
  }
  return fallback
}

export function normaliseHeartwoodIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const uri = value.uri || value.bunker_uri || value.bunkerUri
  if (!isValidBunkerUri(uri)) return null

  const uriPubkey = bunkerPubkey(uri)
  const pubkey = typeof value.pubkey === 'string' && isValidHexPubkey(value.pubkey)
    ? value.pubkey
    : uriPubkey
  if (pubkey && uriPubkey && pubkey !== uriPubkey) return null

  const npub = typeof value.npub === 'string' && value.npub.length <= 128 ? value.npub : ''
  return {
    label: identityLabel(value, 'identity'),
    pubkey: pubkey || uriPubkey,
    npub,
    uri,
  }
}

export function normaliseHeartwoodIdentities(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.identities) ? payload.identities : [])
  return raw.map(normaliseHeartwoodIdentity).filter(Boolean)
}

function heartwoodInstanceName(baseName, identity) {
  const safeBase = safeInstanceName(baseName, 'heartwood')
  if (!identity?.label || identity.label === 'master') return safeBase
  return `${safeBase}:${identity.label}`
}

export function buildHeartwoodIdentityInstances(payload, {
  address = '',
  baseName = 'heartwood',
  clientSecret = '',
} = {}) {
  return normaliseHeartwoodIdentities(payload).map((identity) => {
    const name = heartwoodInstanceName(baseName, identity)
    return {
      id: makeInstanceId(name, identity.uri),
      name,
      address,
      bunkerUri: identity.uri,
      clientSecret,
      npub: identity.npub,
      signingPubkey: '',
      signingVerifiedAt: 0,
      signingLastError: null,
      isHeartwood: true,
      heartwoodBaseName: safeInstanceName(baseName, 'heartwood'),
      heartwoodIdentityLabel: identity.label,
      heartwoodIdentityPubkey: identity.pubkey,
    }
  })
}

function findExistingInstance(instances, next) {
  return instances.find((instance) => {
    if (instance.bunkerUri === next.bunkerUri) return true
    return !!(
      next.address &&
      next.heartwoodIdentityPubkey &&
      instance.address === next.address &&
      instance.heartwoodIdentityPubkey === next.heartwoodIdentityPubkey
    )
  })
}

function upsertInstances(instances, nextInstances, activeInstanceId) {
  const idMap = new Map()

  for (const next of nextInstances) {
    const existing = findExistingInstance(instances, next)
    if (!existing) {
      instances.push(next)
      continue
    }

    const oldId = existing.id
    const previousSigningPubkey = existing.signingPubkey
    const previousSigningVerifiedAt = existing.signingVerifiedAt
    const previousSigningLastError = existing.signingLastError
    const connectionChanged = existing.bunkerUri !== next.bunkerUri ||
      existing.clientSecret !== next.clientSecret

    Object.assign(existing, next)
    if (!connectionChanged) {
      existing.signingPubkey = previousSigningPubkey || next.signingPubkey
      existing.signingVerifiedAt = previousSigningVerifiedAt || next.signingVerifiedAt
      existing.signingLastError = previousSigningLastError ?? next.signingLastError
    }
    if (oldId !== existing.id) idMap.set(oldId, existing.id)
  }

  const mappedActiveId = idMap.get(activeInstanceId) || activeInstanceId
  return { instances, activeInstanceId: mappedActiveId }
}

async function fetchJsonResponse(res, fallbackMessage) {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error || fallbackMessage || `HTTP ${res.status}`)
  }
  return body
}

export async function fetchHeartwoodIdentityPayload(address, fetchImpl = fetch) {
  const res = await fetchImpl(`${address}/api/identities`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  return await fetchJsonResponse(
    res,
    `Server returned HTTP ${res.status} while loading identities.`,
  )
}

export async function importHeartwoodIdentities({
  address,
  instances,
  activeInstanceId,
  baseName,
  clientSecret,
  activatePubkey,
  activateLabel,
  fetchImpl = fetch,
}) {
  const payload = await fetchHeartwoodIdentityPayload(address, fetchImpl)
  const nextInstances = buildHeartwoodIdentityInstances(payload, {
    address,
    baseName,
    clientSecret,
  })
  if (nextInstances.length === 0) {
    return {
      instances,
      activeInstanceId,
      imported: 0,
      activeImportedId: null,
    }
  }

  const upserted = upsertInstances(instances, nextInstances, activeInstanceId)
  let activeImported = nextInstances.find((instance) => (
    (activatePubkey && instance.heartwoodIdentityPubkey === activatePubkey) ||
    (activateLabel && instance.heartwoodIdentityLabel === activateLabel)
  ))
  if (!activeImported) {
    activeImported = nextInstances.find(instance => instance.heartwoodIdentityLabel === 'master') || nextInstances[0]
  }

  return {
    instances: upserted.instances,
    activeInstanceId: upserted.activeInstanceId,
    imported: nextInstances.length,
    activeImportedId: activeImported?.id || null,
  }
}

function validClientSecret(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

// ---------------------------------------------------------------------------
// nostrconnect:// pairing — client-initiated flow where the signer scans a
// QR (or receives the pasted URI) and connects back over the relay
// ---------------------------------------------------------------------------

/** Default relays offered for client-initiated nostrconnect pairing. */
export const DEFAULT_NOSTRCONNECT_RELAYS = ['wss://relay.nsec.app']

/** Maximum time to wait for the signer to respond to a nostrconnect URI (ms). */
const NOSTRCONNECT_WAIT_MS = 180_000

/**
 * Normalise user relay input (string or array) into a deduplicated list of
 * WebSocket relay URLs. Plain ws:// is only accepted for loopback bridges.
 */
export function normaliseNostrConnectRelays(input) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[\s,]+/) : [])
  const relays = []
  for (const candidate of raw) {
    const value = String(candidate || '').trim()
    if (!value) continue
    let url
    try { url = new URL(value) } catch { continue }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol === 'ws:' && !isLoopback) continue
    const href = url.href.replace(/\/$/, '')
    if (!relays.includes(href)) relays.push(href)
  }
  return relays.slice(0, 4)
}

/**
 * Build a nostrconnect:// pairing request: fresh client keypair, random
 * secret, and the URI the signer scans or receives.
 */
export function buildNostrConnectRequest(relayInput, {
  name = 'Bark',
  url = 'https://github.com/forgesworn/bark',
} = {}) {
  const relays = normaliseNostrConnectRelays(relayInput)
  if (relays.length === 0) {
    throw new Error('Invalid relay address. Use wss:// relay URLs.')
  }
  const clientSk = generateSecretKey()
  const secretBytes = new Uint8Array(16)
  crypto.getRandomValues(secretBytes)
  const secret = bytesToHex(secretBytes)
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSk),
    relays,
    secret,
    name,
    url,
  })
  return { uri, clientSecret: bytesToHex(clientSk), relays, secret }
}

/** @type {{ uri: string, status: 'waiting'|'connected'|'error', error: string|null, abort: AbortController }|null} */
let nostrConnectPending = null

/**
 * Start a nostrconnect pairing wait. Returns the URI for the popup to render.
 * The wait continues in the background even if the popup closes.
 */
function startNostrConnectPairing(relayInput) {
  if (nostrConnectPending?.status === 'waiting') {
    nostrConnectPending.abort.abort()
  }

  const request = buildNostrConnectRequest(relayInput)
  const abort = new AbortController()
  const pending = { uri: request.uri, status: 'waiting', error: null, abort }
  nostrConnectPending = pending
  const timeoutId = setTimeout(() => abort.abort(), NOSTRCONNECT_WAIT_MS)

  BunkerSigner.fromURI(hexToBytes(request.clientSecret), request.uri, {
    onauth(authUrl) {
      connectionState.status = 'awaiting-approval'
      connectionState.lastError = 'Approve this connection on your signer.'
      connectionState.authUrl = authUrl || null
    },
  }, abort.signal)
    .then(async (newSigner) => {
      clearTimeout(timeoutId)
      if (nostrConnectPending !== pending) {
        try { newSigner.close() } catch { /* ignore */ }
        return
      }
      await adoptNostrConnectSigner(newSigner, request)
      pending.status = 'connected'
    })
    .catch((err) => {
      clearTimeout(timeoutId)
      if (nostrConnectPending !== pending) return
      pending.status = 'error'
      pending.error = pending.abort.signal.aborted
        ? 'Pairing timed out. Generate a new QR and try again.'
        : sanitiseError(err)
    })

  return { uri: request.uri }
}

/**
 * Persist the instance for a completed nostrconnect pairing and adopt the
 * already-connected signer as the active connection.
 */
async function adoptNostrConnectSigner(newSigner, request) {
  cancelReconnect()
  if (signer) {
    try { signer.close() } catch { /* ignore */ }
  }
  signer = newSigner
  connectPromise = null
  patchSignerPublishFailures(signer)

  const bunkerUri = toBunkerURL(newSigner.bp)
  if (!isValidBunkerUri(bunkerUri)) {
    throw new Error('Server returned an invalid bunker URI.')
  }

  const { instances = [] } = await chrome.storage.local.get(['instances'])
  const existing = instances.find(i => i.bunkerUri === bunkerUri)
  const id = makeInstanceId('nostrconnect', bunkerUri)

  let active
  if (existing) {
    existing.clientSecret = request.clientSecret
    existing.signingVerifiedAt = 0
    existing.signingLastError = null
    existing.signingPubkey = ''
    active = existing
  } else {
    active = {
      id,
      name: 'nostrconnect',
      address: '',
      bunkerUri,
      clientSecret: request.clientSecret,
      npub: '',
      signingPubkey: '',
      signingVerifiedAt: 0,
      signingLastError: null,
      isHeartwood: false,
    }
    instances.push(active)
  }

  await chrome.storage.local.set({ instances, activeInstanceId: active.id })
  await finaliseConnection(active, instances, bunkerUri, newSigner.bp.relays)
}

export async function pairHeartwoodHttpAddress(address, {
  instances = [],
  activeInstanceId = null,
  fetchImpl = fetch,
} = {}) {
  const url = normaliseAddress(address)
  const existing = instances.find(i => i.address === url)
  const clientSk = existing && validClientSecret(existing.clientSecret)
    ? hexToBytes(existing.clientSecret)
    : generateSecretKey()
  const clientPk = getPublicKey(clientSk)
  const clientSecret = bytesToHex(clientSk)

  const res = await fetchImpl(`${url}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bark', pubkey: clientPk }),
  })

  const data = await fetchJsonResponse(res, `HTTP ${res.status}`)

  if (!data.bunkerUri || !isValidBunkerUri(data.bunkerUri)) {
    throw new Error('Server returned an invalid bunker URI.')
  }
  if (data.instance && (typeof data.instance !== 'string' || data.instance.length > 64)) {
    throw new Error('Server returned an invalid instance name.')
  }

  const bunkerUri = data.bunkerUri
  const instanceName = safeInstanceName(data.instance || 'heartwood', 'heartwood')
  const npub = typeof data.npub === 'string' && data.npub.length <= 128 ? data.npub : ''

  try {
    const imported = await importHeartwoodIdentities({
      address: url,
      instances,
      activeInstanceId,
      baseName: instanceName,
      clientSecret,
      activateLabel: 'master',
      fetchImpl,
    })

    if (imported.imported > 0) {
      return {
        instances: imported.instances,
        activeInstanceId: imported.activeImportedId || imported.activeInstanceId,
        imported: imported.imported,
        address: url,
      }
    }
  } catch (err) {
    debug('[bark:bg] could not import Heartwood identities:', sanitiseError(err))
  }

  const id = makeInstanceId(instanceName, bunkerUri)
  if (existing) {
    existing.bunkerUri = bunkerUri
    existing.npub = npub || existing.npub
    existing.name = instanceName || existing.name
    existing.id = id
    existing.clientSecret = clientSecret
    existing.signingVerifiedAt = 0
    existing.signingLastError = null
    existing.signingPubkey = ''
    existing.heartwoodBaseName = instanceName
    existing.heartwoodIdentityLabel = 'master'
    existing.heartwoodIdentityPubkey = bunkerPubkey(bunkerUri)
  } else {
    instances.push({
      id,
      name: instanceName,
      address: url,
      bunkerUri,
      clientSecret,
      npub,
      signingPubkey: '',
      signingVerifiedAt: 0,
      signingLastError: null,
      isHeartwood: true,
      heartwoodBaseName: instanceName,
      heartwoodIdentityLabel: 'master',
      heartwoodIdentityPubkey: bunkerPubkey(bunkerUri),
    })
  }

  return {
    instances,
    activeInstanceId: id,
    imported: 0,
    address: url,
  }
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
      signingVerifiedAt: 0,
      signingLastError: null,
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
  const normalised = normalisePolicies(policies)
  if (policies && policies.version !== normalised.version) {
    await chrome.storage.local.set({ policies: normalised })
  }
  return normalised
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

async function trustSite(origin) {
  if (!origin) throw new Error('Invalid request origin.')
  const policies = await loadPolicies()
  const siteRules = { ...(policies.siteRules || {}) }
  siteRules[origin] = buildTrustedSiteRule(siteRules[origin])
  await chrome.storage.local.set({
    policies: {
      ...policies,
      siteRules,
    },
  })
}

/** Timeout for a displayed approval window (ms). */
const APPROVAL_TIMEOUT_MS = 60_000

/** Maximum time a request may wait in the queue before being displayed (ms). */
const APPROVAL_QUEUE_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------------------
// Approval system — pending requests awaiting user decision
// ---------------------------------------------------------------------------

/** @type {Map<string, { method: string, params: any, event?: object, pubkey: string, personaName: string, origin: string, instanceId?: string, sendResponse: Function, timeoutId: number, windowId?: number }>} */
const pendingApprovals = new Map()

/** @type {string[]} FIFO of requestIds waiting for their approval window. */
const approvalQueue = []

/** @type {string|null} Currently displayed approval request ID, if any. */
let activeApprovalId = null

/** Badge text for a pending approval count. Exported for testing. */
export function approvalBadgeText(count) {
  if (!Number.isInteger(count) || count <= 0) return ''
  return count > 9 ? '9+' : String(count)
}

function updateApprovalBadge() {
  if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return
  const text = approvalBadgeText(pendingApprovals.size)
  chrome.action.setBadgeText({ text })
  if (text && chrome.action.setBadgeBackgroundColor) {
    chrome.action.setBadgeBackgroundColor({ color: '#339933' })
  }
}

/**
 * Queue an approval request. Sites often fire several NIP-07 calls at once
 * (e.g. getPublicKey + signEvent on login), so requests queue and display
 * one at a time instead of rejecting while another approval is pending.
 */
function enqueueApproval(requestId, details) {
  const timeoutId = setTimeout(() => {
    denyApproval(requestId, 'Approval timed out.')
  }, APPROVAL_QUEUE_TIMEOUT_MS)

  pendingApprovals.set(requestId, { ...details, timeoutId })
  approvalQueue.push(requestId)
  updateApprovalBadge()
  void openNextApproval()
}

/**
 * Display the next queued approval window, if none is currently shown.
 * The 60-second attention timeout starts when the window opens.
 */
async function openNextApproval() {
  if (activeApprovalId) return
  const requestId = approvalQueue.shift()
  if (!requestId) return
  const entry = pendingApprovals.get(requestId)
  if (!entry) return openNextApproval()

  activeApprovalId = requestId
  clearTimeout(entry.timeoutId)
  entry.timeoutId = setTimeout(() => {
    denyApproval(requestId, 'Approval timed out.')
  }, APPROVAL_TIMEOUT_MS)

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approve.html?requestId=${requestId}`),
      type: 'popup',
      width: 420,
      height: 520,
      focused: true,
    })
    const stored = pendingApprovals.get(requestId)
    if (stored) stored.windowId = win.id
  } catch (err) {
    denyApproval(requestId, 'Could not open approval window.')
  }
}

/** Remove a request from the pending map and queue; advance the queue. */
function settleApproval(requestId) {
  const entry = pendingApprovals.get(requestId)
  if (!entry) return null
  clearTimeout(entry.timeoutId)
  pendingApprovals.delete(requestId)
  const queued = approvalQueue.indexOf(requestId)
  if (queued !== -1) approvalQueue.splice(queued, 1)
  if (activeApprovalId === requestId) {
    activeApprovalId = null
    void openNextApproval()
  }
  updateApprovalBadge()
  return entry
}

/**
 * Deny a pending approval — resolve the original request with an error.
 */
function denyApproval(requestId, reason) {
  const entry = settleApproval(requestId)
  if (!entry) return
  entry.sendResponse({ error: reason || 'Request denied by user.' })
}

/**
 * Allow a pending approval — execute the original request.
 */
async function allowApproval(requestId, { rememberSite = false } = {}) {
  const entry = settleApproval(requestId)
  if (!entry) return

  // Verify the active instance hasn't changed since the approval was created
  if (entry.instanceId) {
    const { activeInstanceId } = await chrome.storage.local.get('activeInstanceId')
    if (entry.instanceId !== activeInstanceId) {
      entry.sendResponse({ error: 'Active identity changed. Please retry.' })
      return
    }
  }

  try {
    const result = await handleMessage(entry.method, entry.params, entry.origin)
    if (rememberSite) {
      try {
        await trustSite(entry.origin)
      } catch (err) {
        debug('[bark:bg] could not persist trusted site:', sanitiseError(err))
      }
    }
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
 * @returns {{ type: 'nip07'|'nip04'|'nip44'|'heartwood'|'unknown', method: string }}
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
  if (method.startsWith('nip04.')) {
    const sub = method.slice('nip04.'.length)
    if (NIP04_METHODS.has(sub)) {
      return { type: 'nip04', method: sub }
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

function buildRelayPolicy(relays) {
  return Object.fromEntries((relays || []).map((relay) => [
    relay.url || relay,
    { read: true, write: true },
  ]))
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/** Validate that a value looks like a 64-character lowercase hex string. */
export function isValidHexPubkey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

// ---------------------------------------------------------------------------
// Connect metadata helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable app name from a website origin or URL.
 * Returns "Bark" as a fallback when no origin is available.
 *
 * Examples:
 *   "https://nostrudel.ninja"  → "nostrudel.ninja"
 *   "https://snort.social"     → "snort.social"
 *   "chrome-extension://..."   → "Bark"
 *   undefined                  → "Bark"
 *
 * @param {string|undefined} origin
 * @returns {string}
 */
export function appNameFromOrigin(origin) {
  if (!origin) return 'Bark'
  try {
    const url = new URL(origin)
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      // Strip leading "www." for a cleaner label
      return url.hostname.replace(/^www\./, '')
    }
  } catch { /* not a parseable URL */ }
  return 'Bark'
}

/**
 * Determine whether a message came from the extension's own UI. Messages
 * without a tab (action popup, service worker peers) are internal, and so
 * are extension pages opened in a tab (popup.html or diagnostic.html in a
 * pinned tab) — their sender origin is the extension origin itself.
 *
 * @param {chrome.runtime.MessageSender|object} sender
 * @param {string} extensionBaseUrl  chrome.runtime.getURL('') — e.g. "chrome-extension://abc/"
 * @returns {boolean}
 */
export function isInternalSender(sender, extensionBaseUrl) {
  if (!sender?.tab) return true
  return typeof sender.origin === 'string' &&
    typeof extensionBaseUrl === 'string' &&
    sender.origin.length > 0 &&
    extensionBaseUrl.startsWith(`${sender.origin}/`)
}

/**
 * Canonicalize a Chrome message sender into a web origin. Only http/https
 * origins are valid for site policies and web-page NIP-07 requests.
 *
 * @param {chrome.runtime.MessageSender|object} sender
 * @returns {string|null}
 */
export function originFromSender(sender = {}) {
  const candidates = [sender.origin, sender.tab?.url]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue
    try {
      const url = new URL(candidate)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.origin
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Build the NIP-46 connect metadata object from a website origin.
 * The metadata is serialised to JSON and passed as the fourth param of the
 * NIP-46 "connect" request so that the signer can label the client policy
 * with meaningful information. The third param is reserved for requested
 * permissions and is empty when Bark is not requesting a bundle.
 *
 * @param {string|undefined} origin  The requesting website's origin (e.g. "https://nostrudel.ninja")
 * @returns {{ name: string, url: string }}
 */
export function buildConnectMetadata(origin) {
  const name = appNameFromOrigin(origin)
  const url = (origin && origin.startsWith('http')) ? origin : 'bark://extension'
  return { name, url }
}

export function buildConnectParams(bunkerPointer, connectMeta) {
  return [
    bunkerPointer.pubkey,
    bunkerPointer.secret || '',
    '',
    JSON.stringify(connectMeta),
  ]
}

/** Validate a bunker URI matches the expected format. */
export function isValidBunkerUri(value) {
  return typeof value === 'string' && value.length <= 2048 && BUNKER_URI_RE.test(value)
}

/** Validate a purpose string for derivation (alphanumeric, hyphens, underscores, 1-64 chars). */
export function isValidPurpose(value) {
  return typeof value === 'string' && /^[\w:.-]{1,64}$/.test(value)
}

export function normaliseSignEventTemplate(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('signEvent requires an event object.')
  }
  if (typeof params.kind !== 'number' || !Number.isInteger(params.kind)) {
    throw new Error('signEvent requires a numeric kind.')
  }
  if (params.content !== undefined && typeof params.content !== 'string') {
    throw new Error('signEvent requires string content.')
  }
  if (params.tags !== undefined && !Array.isArray(params.tags)) {
    throw new Error('signEvent requires array tags.')
  }
  if (params.created_at !== undefined && !Number.isInteger(params.created_at)) {
    throw new Error('signEvent requires integer created_at.')
  }
  // Some dApps (e.g. coinos's login/register/settings flows) set created_at to
  // Date.now() — milliseconds — which, signed verbatim, dates the event to the
  // year ~58000 and gets rejected by relays and NIP-98 verifiers. Fill it in
  // when absent and coerce milliseconds to seconds (cutoff 10^10 ≈ year 2286 in
  // seconds; any larger integer is, in practice, milliseconds). Matches the
  // de-facto Alby/nos2x behaviour.
  let created_at = params.created_at ?? Math.floor(Date.now() / 1000)
  if (created_at > 10_000_000_000) created_at = Math.floor(created_at / 1000)
  return {
    kind: params.kind,
    content: params.content ?? '',
    tags: params.tags ?? [],
    created_at,
  }
}

export function isRelayPublishFailure(reason) {
  return typeof reason === 'string' && reason.startsWith('connection failure:')
}

export function buildSignerHealthEvent(challenge = makeChallenge()) {
  return {
    kind: 22242,
    content: '',
    tags: [
      ['relay', 'bark://extension'],
      ['challenge', challenge],
      ['client', 'Bark'],
      ['purpose', 'signer-health-check'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  }
}

function makeChallenge() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function patchSignerPublishFailures(bunkerSigner) {
  const pool = bunkerSigner?.pool
  if (!pool || pool.__barkPublishPatched || typeof pool.publish !== 'function') return

  const publish = pool.publish.bind(pool)
  Object.defineProperty(pool, '__barkPublishPatched', { value: true, configurable: true })
  pool.publish = (relays, event, params) => {
    return publish(relays, event, params).map((promise) => {
      return Promise.resolve(promise).then((reason) => {
        if (isRelayPublishFailure(reason)) throw new Error(reason)
        return reason
      })
    })
  }
}

// ---------------------------------------------------------------------------
// NIP-46 connection state
// ---------------------------------------------------------------------------

/** @type {BunkerSigner|null} */
let signer = null

/** @type {Promise<BunkerSigner>|null} Mutex to prevent concurrent connect attempts. */
let connectPromise = null

/**
 * Timestamp of the last site/popup request. Gates the keep-alive window so
 * pings stop once the user goes quiet instead of running forever.
 * @type {number}
 */
let lastActivityTime = Date.now()

/**
 * Timestamp of the last confirmed relay traffic (request or keep-alive ping).
 * Chrome MV3 silently kills WebSocket connections after ~30s of service
 * worker inactivity. The readyState property on the dead WebSocket still
 * reports OPEN (1), so isPoolAlive() is unreliable after idle periods.
 * We force a full reconnect if more than MAX_IDLE_MS has elapsed.
 * @type {number}
 */
let lastSocketActivityTime = Date.now()

/** Force reconnect after this many ms without socket traffic (< MV3's ~30s kill). */
const MAX_IDLE_MS = 20_000

// ---------------------------------------------------------------------------
// Keep-alive — NIP-46 pings hold the socket (and MV3 worker) open during
// active use, so human-paced interactions don't pay a reconnect every time
// ---------------------------------------------------------------------------

/** Ping cadence while active (< MV3's ~30s idle kill). */
const KEEP_ALIVE_INTERVAL_MS = 20_000

/** Stop pinging this long after the last real request. */
const KEEP_ALIVE_WINDOW_MS = 120_000

let keepAliveTimer = null

function scheduleKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setTimeout(keepAliveTick, KEEP_ALIVE_INTERVAL_MS)
}

async function keepAliveTick() {
  keepAliveTimer = null
  if (!signer) return
  if (Date.now() - lastActivityTime > KEEP_ALIVE_WINDOW_MS) return
  try {
    await withTimeout(signer.ping(), 5_000, 'Keep-alive ping')
    lastSocketActivityTime = Date.now()
  } catch (err) {
    // Any response — even "unknown method" from a bunker without ping —
    // proves the socket is alive. Only a timeout suggests it is dead, in
    // which case the next request's idle check forces a reconnect.
    const msg = typeof err === 'string' ? err : (err?.message || '')
    if (!msg.includes('timed out')) lastSocketActivityTime = Date.now()
  }
  scheduleKeepAlive()
}

function cancelKeepAlive() {
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer)
    keepAliveTimer = null
  }
}

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
  debug(`[bark:bg] reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`)
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

/** @type {{ status: string, lastError: string|null, relays: Array<{url: string, connected: boolean}>, isHeartwood: boolean, signingStatus: string, signingLastOkAt: number|null, signingLastError: string|null, signingPubkey: string|null, signingProbeReason: string|null }} */
let connectionState = {
  status: 'disconnected',
  lastError: null,
  authUrl: null,
  relays: [],
  isHeartwood: false,
  signingStatus: 'untested',
  signingLastOkAt: null,
  signingLastError: null,
  signingPubkey: null,
  signingProbeReason: null,
}

let primePromise = null
let autoPrimeTimer = null

function applyInstanceSigningState(active) {
  connectionState.signingStatus = active?.signingVerifiedAt ? 'ready' : 'untested'
  connectionState.signingLastOkAt = active?.signingVerifiedAt || null
  connectionState.signingLastError = active?.signingLastError || null
  connectionState.signingPubkey = active?.signingPubkey || null
  connectionState.signingProbeReason = null
}

function setSigningState(status, updates = {}) {
  connectionState.signingStatus = status
  Object.assign(connectionState, updates)
}

async function updateActiveInstanceSigningState(updates) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return

  const { instances = [], activeInstanceId } = await chrome.storage.local.get([
    'instances',
    'activeInstanceId',
  ])
  const active = instances.find(i => i.id === activeInstanceId)
  if (!active) return

  Object.assign(active, updates)
  await chrome.storage.local.set({ instances })
}

async function markSigningSucceeded(signed) {
  const now = Date.now()
  const signingPubkey = typeof signed?.pubkey === 'string' ? signed.pubkey : null

  setSigningState('ready', {
    signingLastOkAt: now,
    signingLastError: null,
    signingPubkey,
    signingProbeReason: null,
  })

  await updateActiveInstanceSigningState({
    signingVerifiedAt: now,
    signingLastError: null,
    signingPubkey: signingPubkey || '',
  })
}

async function markSigningFailed(err) {
  const error = sanitiseError(err)
  setSigningState('error', {
    signingLastError: error,
    signingProbeReason: null,
  })
  await updateActiveInstanceSigningState({
    signingLastError: error,
  })
}

async function signWithHealthTracking(bunker, event, label, reason = 'request') {
  setSigningState('pending', {
    signingLastError: null,
    signingProbeReason: reason,
  })

  try {
    const signed = await withBunkerRequestTimeout(bunker.signEvent(event), label)
    await markSigningSucceeded(signed)
    return signed
  } catch (err) {
    await markSigningFailed(err)
    throw err
  }
}

async function primeSigner(reason = 'manual') {
  if (primePromise) return primePromise

  primePromise = (async () => {
    const bunker = await ensureConnected()
    return await signWithHealthTracking(
      bunker,
      buildSignerHealthEvent(),
      'signer health check',
      reason,
    )
  })()

  try {
    return await primePromise
  } finally {
    primePromise = null
  }
}

function scheduleSignerPrime(reason = 'initial') {
  if (autoPrimeTimer || primePromise || connectionState.signingStatus === 'ready') return
  autoPrimeTimer = setTimeout(() => {
    autoPrimeTimer = null
    if (connectionState.signingStatus !== 'untested') return
    primeSigner(reason).catch((err) => {
      debug('[bark:bg] signer health check failed:', sanitiseError(err))
    })
  }, 1000)
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
        await withTimeout(
          signer.pool.ensureRelay(url, { connectionTimeout: 5000 }),
          RELAY_PROBE_TIMEOUT_MS,
          'Relay probe',
        )
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
    debug('[bark:bg] isPoolAlive: no pool or relays')
    return false
  }
  const relayMap = signer.pool.relays
  if (relayMap.size === 0) {
    debug('[bark:bg] isPoolAlive: relay map is empty')
    return false
  }
  let alive = false
  relayMap.forEach((relay, url) => {
    const wsState = relay?.ws?.readyState
    const connected = relay?.connected
    debug('[bark:bg] isPoolAlive:', url, 'connected:', connected, 'ws.readyState:', wsState)
    if (connected || wsState === 1) alive = true
  })
  if (!alive) debug('[bark:bg] isPoolAlive: no live relays')
  return alive
}

/**
 * Ensure a live NIP-46 connection exists, establishing one if necessary.
 *
 * @param {string} [originHint]  The website origin that triggered this request
 *   (e.g. "https://nostrudel.ninja"). Passed to doConnect() so it can include
 *   app metadata in the NIP-46 connect handshake for Heartwood policy labelling.
 *   Only used on the first connect for a given instance; ignored on reconnects
 *   (the stored connectLabel is used instead).
 */
async function ensureConnected(originHint) {
  // If we have a signer but the relay pool is dead, tear it down so
  // doConnect() creates a fresh one with live WebSocket connections.
  // MV3 kills WebSockets silently — readyState stays OPEN even after
  // the underlying connection is gone. Use idle time as a second check.
  if (signer) {
    const idleMs = Date.now() - lastSocketActivityTime
    if (idleMs > MAX_IDLE_MS) {
      debug(`[bark:bg] idle ${Math.round(idleMs / 1000)}s > ${MAX_IDLE_MS / 1000}s — forcing reconnect`)
      try { signer.close() } catch { /* ignore */ }
      signer = null
    } else if (!isPoolAlive()) {
      debug('[bark:bg] pool connections dead — forcing reconnect')
      try { signer.close() } catch { /* ignore */ }
      signer = null
    }
  }
  if (signer) return signer
  if (connectPromise) return connectPromise
  connectPromise = doConnect(originHint)
  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

async function doConnect(originHint) {

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
    debug('[bark] Migrated legacy storage to multi-instance format')
  }

  // Read multi-instance state
  const { instances = [], activeInstanceId } = await chrome.storage.local.get([
    'instances',
    'activeInstanceId',
  ])
  const active = instances.find(i => i.id === activeInstanceId)
  if (!active) {
    connectionState.status = 'disconnected'
    applyInstanceSigningState(null)
    throw new Error('No Heartwood instance configured. Open the Bark popup to connect.')
  }

  applyInstanceSigningState(active)

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

  // Determine the connect metadata to include in the NIP-46 handshake.
  // Heartwood uses this to label the TOFU client policy on-device.
  // Prefer: (1) a previously stored label for this instance, (2) the origin
  // of the website that triggered this connection, (3) a generic Bark label.
  const connectOrigin = active.connectOrigin || originHint
  const connectMeta = buildConnectMetadata(connectOrigin)

  // Persist the origin on first use so that reconnects produce the same label.
  if (!active.connectOrigin && connectOrigin) {
    active.connectOrigin = connectOrigin
    await chrome.storage.local.set({ instances })
  }

  signer = BunkerSigner.fromBunker(clientSk, bp, {
    onauth(authUrl) {
      connectionState.status = 'awaiting-approval'
      connectionState.lastError = 'Approve this connection on your signer.'
      connectionState.authUrl = authUrl || null
    },
  })
  patchSignerPublishFailures(signer)

  try {
    // Send the connect request directly so we can include app metadata as the
    // optional fourth parameter. The third parameter is requested permissions;
    // pass an empty string when no permission bundle is requested.
    //
    // The signer answers in well under a second, so a slow reply almost always
    // means the relay subscription wasn't ready when the response arrived (MV3
    // cold socket) — the response was missed, not refused. Rather than stall on
    // one long CONNECT_TIMEOUT_MS wait, re-publish connect on a short per-attempt
    // timeout: a missed first response recovers in a few seconds instead of ~30s.
    // Total budget stays ~CONNECT_TIMEOUT_MS; on exhaustion we fall through to
    // the existing backoff path. Re-sending connect is idempotent on Heartwood
    // (exact-match secret → same slot re-acked).
    const CONNECT_ATTEMPT_TIMEOUT_MS = 6000
    const maxConnectAttempts = Math.max(1, Math.ceil(CONNECT_TIMEOUT_MS / CONNECT_ATTEMPT_TIMEOUT_MS))
    let connectOk = false
    let lastConnectErr = null
    for (let attempt = 1; attempt <= maxConnectAttempts && !connectOk; attempt++) {
      try {
        await Promise.race([
          signer.sendRequest('connect', buildConnectParams(bp, connectMeta)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('connect attempt timed out')), CONNECT_ATTEMPT_TIMEOUT_MS),
          ),
        ])
        connectOk = true
      } catch (err) {
        lastConnectErr = err
        if (attempt < maxConnectAttempts) {
          debug(`[bark:bg] connect attempt ${attempt}/${maxConnectAttempts} timed out; re-publishing…`)
        }
      }
    }
    if (!connectOk) throw lastConnectErr || new Error('Connection timed out.')
  } catch (err) {
    signer = null
    connectionState.status = 'disconnected'
    connectionState.lastError = sanitiseError(err)
    scheduleReconnect()
    await probeRelays(bp.relays)
    throw err
  }

  await finaliseConnection(active, instances, bunkerUri, bp.relays)

  return signer
}

/**
 * Shared post-connect steps for both the bunker:// path (doConnect) and the
 * client-initiated nostrconnect path: mark connected, probe relay health,
 * detect Heartwood capabilities, and schedule the signing health check.
 */
async function finaliseConnection(active, instances, bunkerUri, relays) {
  cancelReconnect()
  connectionState.status = 'connected'
  connectionState.lastError = null
  connectionState.authUrl = null
  lastActivityTime = Date.now()
  lastSocketActivityTime = Date.now()
  scheduleKeepAlive()

  // Probe relay health
  await probeRelays(relays)

  // Detect Heartwood mode and approval status.
  let heartwoodIdentityList = []
  try {
    const raw = await withTimeout(
      signer.sendRequest('heartwood_list_identities', []),
      HEARTWOOD_PROBE_TIMEOUT_MS,
      'Heartwood identity probe',
    )
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) heartwoodIdentityList = parsed
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
      connectionState.isHeartwood = !isUnsupportedHeartwoodProbeError(msg)
    }
  }

  if (connectionState.isHeartwood) {
    const targetPubkey = bunkerPubkey(bunkerUri)
    const matchedIdentity = heartwoodIdentityList.find(identity => identity?.pubkey === targetPubkey)
    const label = matchedIdentity ? identityLabel(matchedIdentity, 'master') : (active.heartwoodIdentityLabel || 'master')

    active.isHeartwood = true
    active.heartwoodBaseName = active.heartwoodBaseName || safeInstanceName(active.name || 'heartwood', 'heartwood')
    active.heartwoodIdentityLabel = label
    active.heartwoodIdentityPubkey = targetPubkey || active.heartwoodIdentityPubkey
    if (active.name === 'bunker' && label && label !== 'master') active.name = label
    await chrome.storage.local.set({ instances, isHeartwood: true })
  } else {
    await chrome.storage.local.set({ isHeartwood: false })
  }

  if (!active.signingVerifiedAt) scheduleSignerPrime('initial')
}

/**
 * Tear down the current connection (used by bark-reset).
 */
async function resetConnection({ clearSigning = true } = {}) {
  cancelReconnect()
  cancelKeepAlive()
  if (autoPrimeTimer) {
    clearTimeout(autoPrimeTimer)
    autoPrimeTimer = null
  }
  if (signer) {
    try { signer.close() } catch { /* ignore */ }
  }
  signer = null
  connectPromise = null
  connectionState.status = 'disconnected'
  connectionState.lastError = null
  connectionState.authUrl = null
  connectionState.relays = []
  connectionState.isHeartwood = false
  if (clearSigning) {
    setSigningState('untested', {
      signingLastOkAt: null,
      signingLastError: null,
      signingPubkey: null,
      signingProbeReason: null,
    })
  }
}

async function withBunkerRequestTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), BUNKER_REQUEST_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err?.message || '')
    if (msg.endsWith(' timed out.')) {
      void resetConnection({ clearSigning: false })
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

/**
 * Handle a classified request by delegating to the appropriate BunkerSigner
 * method.
 *
 * @param {string} method      Raw method string from the content script
 * @param {*}      params      Parameters accompanying the request
 * @param {string} [originHint]  The requesting website origin, forwarded to
 *   ensureConnected() so the NIP-46 connect handshake can include app metadata
 *   for Heartwood TOFU policy labelling.
 * @returns {Promise<*>}
 */
async function handleMessage(method, params, originHint) {
  // Validate method is a string.
  if (typeof method !== 'string' || method.length === 0 || method.length > 64) {
    throw new Error('Invalid method.')
  }

  const parsed = parseMethod(method)
  debug('[bark:bg] handleMessage', parsed.type, parsed.method, 'connecting...')
  const bunker = await ensureConnected(originHint)
  debug('[bark:bg] handleMessage', parsed.type, parsed.method, 'connected, dispatching')

  // Update activity timestamps so the idle-time reconnect logic knows the
  // relay WebSockets were recently used, and keep-alive pings keep them warm.
  lastActivityTime = Date.now()
  lastSocketActivityTime = Date.now()
  scheduleKeepAlive()

  switch (parsed.type) {
    case 'nip07': {
      if (parsed.method === 'getPublicKey') {
        return await withBunkerRequestTimeout(bunker.getPublicKey(), 'getPublicKey')
      }
      if (parsed.method === 'getRelays') {
        return buildRelayPolicy(connectionState.relays)
      }
      if (parsed.method === 'signEvent') {
        const event = normaliseSignEventTemplate(params)
        debug('[bark:bg] signEvent: calling bunker.signEvent()', {
          kind: event.kind,
          created_at: event.created_at,
          tags: Array.isArray(event.tags) ? event.tags.length : 0,
        })
        const signed = await signWithHealthTracking(bunker, event, 'signEvent', 'site-request')
        debug('[bark:bg] signEvent: bunker returned', {
          kind: signed?.kind,
          pubkey: typeof signed?.pubkey === 'string' ? `${signed.pubkey.slice(0, 12)}…` : typeof signed?.pubkey,
          id: typeof signed?.id === 'string' ? `${signed.id.slice(0, 12)}…` : typeof signed?.id,
        })
        return signed
      }
      break
    }

    case 'nip04': {
      if (parsed.method === 'encrypt') {
        if (!params || typeof params.pubkey !== 'string' || typeof params.plaintext !== 'string') {
          throw new Error('nip04.encrypt requires pubkey and plaintext.')
        }
        if (!isValidHexPubkey(params.pubkey)) {
          throw new Error('Invalid pubkey for nip04.encrypt.')
        }
        return await withBunkerRequestTimeout(
          bunker.nip04Encrypt(params.pubkey, params.plaintext),
          'nip04.encrypt',
        )
      }
      if (parsed.method === 'decrypt') {
        if (!params || typeof params.pubkey !== 'string' || typeof params.ciphertext !== 'string') {
          throw new Error('nip04.decrypt requires pubkey and ciphertext.')
        }
        if (!isValidHexPubkey(params.pubkey)) {
          throw new Error('Invalid pubkey for nip04.decrypt.')
        }
        return await withBunkerRequestTimeout(
          bunker.nip04Decrypt(params.pubkey, params.ciphertext),
          'nip04.decrypt',
        )
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
        return await withBunkerRequestTimeout(
          bunker.nip44Encrypt(params.pubkey, params.plaintext),
          'nip44.encrypt',
        )
      }
      if (parsed.method === 'decrypt') {
        if (!params || typeof params.pubkey !== 'string' || typeof params.ciphertext !== 'string') {
          throw new Error('nip44.decrypt requires pubkey and ciphertext.')
        }
        if (!isValidHexPubkey(params.pubkey)) {
          throw new Error('Invalid pubkey for nip44.decrypt.')
        }
        return await withBunkerRequestTimeout(
          bunker.nip44Decrypt(params.pubkey, params.ciphertext),
          'nip44.decrypt',
        )
      }
      break
    }

    case 'heartwood': {
      const args = buildHeartwoodArgs(parsed.method, params)
      debug('[bark:bg] heartwood request:', parsed.method, JSON.stringify(args))
      let raw
      try {
        raw = await withBunkerRequestTimeout(
          bunker.sendRequest(parsed.method, args),
          parsed.method,
        )
      } catch (hwErr) {
        debug('[bark:bg] heartwood error:', parsed.method, String(hwErr))
        throw hwErr
      }
      debug('[bark:bg] heartwood response:', parsed.method, typeof raw === 'string' ? raw.slice(0, 200) : typeof raw)
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
    case 'heartwood_derive_persona': {
      if (!params || typeof params.name !== 'string' || !/^[\w.-]{1,64}$/.test(params.name)) {
        throw new Error('heartwood_derive_persona requires a valid name (alphanumeric/hyphens/dots, 1-64 chars).')
      }
      const index = Number(params.index ?? 0)
      if (!Number.isInteger(index) || index < 0 || index > 1000) {
        throw new Error('heartwood_derive_persona index must be an integer 0-1000.')
      }
      return [params.name, String(index)]
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
  'Invalid relay address',
  'Pairing timed out',
  'Bunker URI must',
  'Connection timed out',
  'Invalid method',
  'Invalid request origin',
  'signEvent requires',
  'nip04.',
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
  // Pass through short, non-sensitive NIP-46 error strings from the signer
  // (e.g. "identity not found in cache") so the user can see what went wrong.
  // Block anything that looks like a file path or stack trace.
  if (msg.length <= 120 && !msg.includes('/') && !msg.includes('\\')) return msg
  return 'Request failed.'
}

export function isUnsupportedHeartwoodProbeError(message) {
  const msg = String(message || '')
  return msg.includes('Heartwood identity probe timed out')
    || msg.includes('unknown method')
    || msg.includes('not supported')
    || msg.includes('unsupported')
    || msg.includes('unrecognised')
    || msg.includes('unrecognized')
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
    if (sender.id && sender.id !== chrome.runtime.id) return
    if (!sender.id && !sender.tab && sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) return

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
          const { instances = [], activeInstanceId } = await chrome.storage.local.get([
            'instances',
            'activeInstanceId',
          ])
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
            const result = await pairHeartwoodHttpAddress(address, {
              instances,
              activeInstanceId,
            })
            await chrome.storage.local.set({
              instances: result.instances,
              activeInstanceId: result.activeInstanceId,
            })
            signer = null
            connectPromise = null
            sendResponse({ ok: true, imported: result.imported })
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
            existing.signingVerifiedAt = 0
            existing.signingLastError = null
            existing.signingPubkey = ''
          } else {
            instances.push({
              id,
              name: instanceName,
              address: pairAddress,
              bunkerUri,
              clientSecret: bytesToHex(clientSk),
              npub,
              signingPubkey: '',
              signingVerifiedAt: 0,
              signingLastError: null,
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

    if (message.type === 'bark-nostrconnect-start') {
      try {
        const result = startNostrConnectPairing(message.relays)
        sendResponse({ ok: true, uri: result.uri })
      } catch (err) {
        sendResponse({ ok: false, error: sanitiseError(err) })
      }
      return true
    }

    if (message.type === 'bark-nostrconnect-status') {
      if (!nostrConnectPending) {
        sendResponse(null)
        return true
      }
      sendResponse({
        status: nostrConnectPending.status,
        error: nostrConnectPending.error,
        uri: nostrConnectPending.uri,
      })
      return true
    }

    if (message.type === 'bark-nostrconnect-cancel') {
      if (nostrConnectPending) {
        const pending = nostrConnectPending
        nostrConnectPending = null
        if (pending.status === 'waiting') pending.abort.abort()
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'bark-refresh-heartwood-identities') {
      const { activatePubkey, activateLabel } = message;
      (async () => {
        try {
          const { instances = [], activeInstanceId } = await chrome.storage.local.get([
            'instances',
            'activeInstanceId',
          ])
          const active = instances.find(i => i.id === activeInstanceId)
          if (!active?.address || !active?.clientSecret) {
            throw new Error('No Heartwood instance configured. Pair with a Heartwood address first.')
          }
          if (!/^https?:\/\//.test(active.address)) {
            throw new Error('No Heartwood instance configured. Pair with a Heartwood address first.')
          }

          const imported = await importHeartwoodIdentities({
            address: active.address,
            instances,
            activeInstanceId,
            baseName: active.heartwoodBaseName || active.name || 'heartwood',
            clientSecret: active.clientSecret,
            activatePubkey,
            activateLabel,
          })

          const nextActiveId = imported.activeImportedId || imported.activeInstanceId
          await chrome.storage.local.set({
            instances: imported.instances,
            activeInstanceId: nextActiveId,
          })

          if (nextActiveId !== activeInstanceId) {
            if (signer) {
              try { signer.close() } catch {}
              signer = null
            }
            connectPromise = null
            connectionState.status = 'connecting'
            ensureConnected().catch(() => {})
          }

          sendResponse({
            ok: true,
            imported: imported.imported,
            activeInstanceId: nextActiveId,
          })
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
        canTrustSite: !!entry.origin,
      })
      return true
    }

    if (message.type === 'bark-approval-response') {
      const { requestId: rid, decision } = message
      if (decision === 'allow' || decision === 'allow-once') {
        allowApproval(rid)
      } else if (decision === 'allow-site') {
        allowApproval(rid, { rememberSite: true })
      } else {
        denyApproval(rid, 'Request denied by user.')
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'bark-prime-signer') {
      (async () => {
        try {
          const signed = await primeSigner('manual')
          sendResponse({
            ok: true,
            pubkey: signed?.pubkey || '',
            id: signed?.id || '',
          })
        } catch (err) {
          debug('[bark:bg] ✗ signer health check error', err, sanitiseError(err))
          sendResponse({ ok: false, error: sanitiseError(err) })
        }
      })()
      return true
    }

    if (message.type === 'bark-request') {
      debug('[bark:bg] ← request', message.method, 'from', sender.tab ? 'tab' : 'extension');
      (async () => {
        // Extension-internal requests (popup, or extension pages opened in a
        // tab) bypass policy checks.
        if (isInternalSender(sender, chrome.runtime.getURL(''))) {
          try {
            const result = await handleMessage(message.method, message.params)
            debug('[bark:bg] → response', message.method, typeof result === 'string' ? result.slice(0, 40) : typeof result)
            sendResponse(result)
          } catch (err) {
            debug('[bark:bg] ✗ error', message.method, err, sanitiseError(err))
            sendResponse({ error: sanitiseError(err) })
          }
          return
        }

        const origin = originFromSender(sender)
        if (!origin) {
          sendResponse({ error: 'Invalid request origin.' })
          return
        }

        const decision = await checkApproval(message.method, message.params, origin)

        if (decision === 'deny') {
          debug('[bark:bg] request denied by policy for', message.method)
          sendResponse({ error: 'Request denied by policy.' })
          return
        }

        if (decision === 'ask') {
          debug('[bark:bg] approval required for', message.method)
          const requestId = `approval-${crypto.randomUUID()}`

          try {
            const bunker = await ensureConnected(origin)
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

            enqueueApproval(requestId, {
              method: message.method,
              params: message.params,
              // Preview the normalised event so it matches what handleMessage
              // will actually sign. Throws here (caught below) reject an invalid
              // template up front instead of after a pointless approval dialog.
              event: message.method === 'signEvent' ? normaliseSignEventTemplate(message.params) : undefined,
              pubkey,
              personaName,
              instanceId: approvalInstanceId,
              origin,
              sendResponse,
            })
          } catch (err) {
            debug('[bark:bg] ✗ approval setup error', message.method, err, sanitiseError(err))
            sendResponse({ error: sanitiseError(err) })
          }
          return
        }

        // decision === 'allow'
        try {
          const result = await handleMessage(message.method, message.params, origin)
          debug('[bark:bg] → response', message.method, typeof result === 'string' ? result.slice(0, 40) : typeof result)
          sendResponse(result)
        } catch (err) {
          debug('[bark:bg] ✗ error', message.method, err, sanitiseError(err))
          sendResponse({ error: sanitiseError(err) })
        }
      })()
      return true // keep channel open for async response
    }
  })
}
