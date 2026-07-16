// Popup UI logic — persona management, Heartwood detection, relay display.

import { nip19 } from 'nostr-tools'
import { renderSVG } from 'uqr'
import { DEFAULT_POLICIES, normalisePolicies } from './policy.js'

const callbackApi = globalThis.chrome
const promiseApi = globalThis.browser && !globalThis.chrome ? globalThis.browser : null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function sendRuntimeMessage(message) {
  if (callbackApi?.runtime?.sendMessage) {
    return new Promise((resolve, reject) => {
      callbackApi.runtime.sendMessage(message, (result) => {
        const err = callbackApi.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(result)
      })
    })
  }
  if (promiseApi?.runtime?.sendMessage) return promiseApi.runtime.sendMessage(message)
  return Promise.reject(new Error('Extension runtime unavailable.'))
}

function storageGet(keys) {
  if (callbackApi?.storage?.local) {
    return new Promise((resolve) => callbackApi.storage.local.get(keys, resolve))
  }
  if (promiseApi?.storage?.local) return promiseApi.storage.local.get(keys)
  return Promise.resolve({})
}

function storageSet(items) {
  if (callbackApi?.storage?.local) {
    return new Promise((resolve) => callbackApi.storage.local.set(items, resolve))
  }
  if (promiseApi?.storage?.local) return promiseApi.storage.local.set(items)
  return Promise.resolve()
}

function storageRemove(keys) {
  if (callbackApi?.storage?.local) {
    return new Promise((resolve) => callbackApi.storage.local.remove(keys, resolve))
  }
  if (promiseApi?.storage?.local) return promiseApi.storage.local.remove(keys)
  return Promise.resolve()
}

function requestOptionalPermission(permission) {
  if (callbackApi?.permissions?.request) {
    return new Promise((resolve) => callbackApi.permissions.request(permission, resolve))
  }
  if (promiseApi?.permissions?.request) return promiseApi.permissions.request(permission)
  return Promise.resolve(true)
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const setupScreen = document.getElementById('setup-screen')
const mainScreen = document.getElementById('main-screen')
const statusDot = document.getElementById('status-dot')

// Multi-instance UI refs
const heartwoodAddress = document.getElementById('heartwood-address')
const pairBtn = document.getElementById('pair-btn')
const pairError = document.getElementById('pair-error')
const instanceListEl = document.getElementById('instance-list')
const addAddressInput = document.getElementById('add-address')
const addPairBtn = document.getElementById('add-pair-btn')
const showAddBtn = document.getElementById('show-add-btn')
const addInstanceSection = document.getElementById('add-instance-section')
const heartwoodBadge = document.getElementById('heartwood-badge')
const activeName = document.getElementById('active-name')
const activeNpub = document.getElementById('active-npub')
const connectedContent = document.getElementById('connected-content')
const signStatusDot = document.getElementById('sign-status-dot')
const signStatusText = document.getElementById('sign-status-text')
const signStatusDetail = document.getElementById('sign-status-detail')
const signTestBtn = document.getElementById('sign-test-btn')
const reconnectStatus = document.getElementById('reconnect-status')
const reconnectMsg = document.getElementById('reconnect-msg')
const retryBtn = document.getElementById('retry-btn')
const authUrlBtn = document.getElementById('auth-url-btn')
const relayInfo = document.getElementById('relay-info')
const relaySummary = document.getElementById('relay-summary')
const relayDetails = document.getElementById('relay-details')
const personaSection = document.getElementById('persona-section')
const personaList = document.getElementById('persona-list')
const deriveInput = document.getElementById('derive-input')
const deriveBtn = document.getElementById('derive-btn')
const standardBunkerCard = document.getElementById('standard-bunker-card')
const disconnectBtn = document.getElementById('disconnect-btn')
const errorMsg = document.getElementById('error-msg')
const connectStatus = document.getElementById('connect-status')

// nostrconnect QR pairing refs
const nostrconnectSection = document.getElementById('nostrconnect-section')
const qrHostMain = document.getElementById('qr-host-main')
const qrShowBtn = document.getElementById('qr-show-btn')
const qrFlow = document.getElementById('qr-flow')
const qrRelayInput = document.getElementById('qr-relay-input')
const qrStartBtn = document.getElementById('qr-start-btn')
const qrCode = document.getElementById('qr-code')
const qrUri = document.getElementById('qr-uri')
const qrActions = document.querySelector('.qr-actions')
const qrCopyBtn = document.getElementById('qr-copy-btn')
const qrCancelBtn = document.getElementById('qr-cancel-btn')
const qrStatus = document.getElementById('qr-status')

// Policy UI refs
const policyToggle = document.getElementById('policy-toggle')
const policyArrow = document.getElementById('policy-arrow')
const policyContent = document.getElementById('policy-content')
const kindRulesList = document.getElementById('kind-rules-list')
const addKindInput = document.getElementById('add-kind-input')
const addKindBtn = document.getElementById('add-kind-btn')
const siteRulesList = document.getElementById('site-rules-list')
const addSiteInput = document.getElementById('add-site-input')
const addSiteAction = document.getElementById('add-site-action')
const addSiteBtn = document.getElementById('add-site-btn')
const resetPoliciesBtn = document.getElementById('reset-policies-btn')

/** Ask the background worker to do a real local sign probe. */
async function primeSigner() {
  const resp = await sendRuntimeMessage({ type: 'bark-prime-signer' })
  if (!resp || !resp.ok) throw new Error(resp?.error || 'Signer test failed.')
  return resp
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send an RPC request to the background service worker. */
async function rpc(method, params) {
  const result = await sendRuntimeMessage({ type: 'bark-request', method, params })
  if (result && result.error) throw new Error(result.error)
  return result
}

/** Query connection state from the background worker. */
async function queryStatus() {
  try {
    const result = await sendRuntimeMessage({ type: 'bark-status' })
    return result || { status: 'disconnected', lastError: null, relays: [], isHeartwood: false }
  } catch {
    return {
      status: 'disconnected',
      lastError: 'Extension error',
      relays: [],
      isHeartwood: false,
    }
  }
}

/** Truncate a hex pubkey for display: first 8 + "..." + last 8 chars. */
function truncateNpub(hex) {
  if (!hex || hex.length <= 20) return hex || ''
  return hex.slice(0, 8) + '...' + hex.slice(-8)
}

/** Show the error message div for 5 seconds. */
let errorTimer = null
function showError(msg) {
  errorMsg.textContent = msg
  errorMsg.classList.add('visible')
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => {
    errorMsg.classList.remove('visible')
  }, 5000)
}

/** Original parent of the shared QR pairing section (setup screen). */
const qrHostSetup = document.getElementById('nostrconnect-section')?.parentElement

/** Switch visible screen. */
function showScreen(screen) {
  setupScreen.classList.remove('active')
  mainScreen.classList.remove('active')
  screen.classList.add('active')
  // The QR pairing section is shared between screens; return it to the
  // setup screen whenever that screen is shown.
  if (screen === setupScreen && qrHostSetup && nostrconnectSection.parentElement !== qrHostSetup) {
    qrHostSetup.appendChild(nostrconnectSection)
  }
}

function pairingPermissionOrigin(address) {
  if (address.startsWith('bunker://')) return null
  let url = address.trim()
  if (!/^https?:\/\//.test(url)) url = `http://${url}`
  return `${new URL(url).origin}/*`
}

async function requestPairingPermission(address) {
  const origin = pairingPermissionOrigin(address)
  if (!origin) return

  const permission = { origins: [origin] }
  const granted = await requestOptionalPermission(permission)
  if (!granted) throw new Error('Pairing permission denied.')
}

// ---------------------------------------------------------------------------
// Instance card rendering and actions
// ---------------------------------------------------------------------------

/** Render the instance card list from storage. */
async function renderInstances() {
  const { instances = [], activeInstanceId } = await storageGet([
    'instances', 'activeInstanceId',
  ])

  if (instances.length === 0) {
    showScreen(setupScreen)
    return false
  }

  showScreen(mainScreen)
  instanceListEl.innerHTML = instances.map(inst => {
    const isActive = inst.id === activeInstanceId
    const statusClass = isActive ? 'connected' : 'inactive'
    const cardClass = isActive ? 'instance-card active' : 'instance-card'
    const npubShort = inst.npub ? inst.npub.slice(0, 20) + '...' : 'connecting...'
    const safeId = escapeHtml(inst.id)
    return `<div class="${cardClass}" data-id="${safeId}">
      <span class="inst-status ${statusClass}"></span>
      <div style="flex:1; min-width:0;">
        <div class="inst-name">${escapeHtml(inst.name)}</div>
        <div class="inst-npub">${escapeHtml(npubShort)}</div>
      </div>
      <button class="inst-remove" data-id="${safeId}" title="Remove">&times;</button>
    </div>`
  }).join('')

  // Click to switch
  instanceListEl.querySelectorAll('.instance-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('inst-remove')) return
      const id = card.dataset.id
      if (id !== activeInstanceId) switchInstance(id)
    })
  })

  // Click to remove
  instanceListEl.querySelectorAll('.inst-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      removeInstance(btn.dataset.id)
    })
  })

  return true
}

async function pairHeartwood(address) {
  if (!address) {
    pairError.textContent = 'Enter a signer or bridge address (e.g. heartwood.local:3000)'
    pairError.classList.remove('hidden')
    return
  }
  pairError.classList.add('hidden')
  const btn = document.activeElement === addPairBtn ? addPairBtn : pairBtn
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = 'Connecting...'

  try {
    await requestPairingPermission(address)

    const resp = await sendRuntimeMessage({ type: 'bark-pair', address })
    if (!resp) throw new Error('No response from background - try reloading the extension')
    if (!resp.ok) throw new Error(resp.error || 'Pairing failed')

    await renderInstances()
    await refreshState()

    if (addAddressInput) addAddressInput.value = ''
    if (addInstanceSection) addInstanceSection.style.display = 'none'
    if (showAddBtn) showAddBtn.style.display = ''
  } catch (err) {
    pairError.textContent = err.message
    pairError.classList.remove('hidden')
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
}

async function switchInstance(instanceId) {
  const card = instanceListEl.querySelector(`[data-id="${instanceId}"]`)
  if (card) {
    const nameEl = card.querySelector('.inst-name')
    if (nameEl) nameEl.textContent += ' (connecting...)'
  }

  try {
    const result = await sendRuntimeMessage({ type: 'bark-switch', instanceId })
    if (!result?.ok) showError(result?.error || 'Could not switch identity.')
    await renderInstances()
    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

async function removeInstance(instanceId) {
  if (!confirm('Remove this signer instance?')) return

  let result
  try {
    result = await sendRuntimeMessage({ type: 'bark-remove', instanceId })
  } catch (err) {
    showError(err.message)
    return
  }

  if (!result?.ok) {
    showError(result?.error || 'Could not remove instance.')
    return
  }
  await renderInstances()
  if (result.remaining > 0) await refreshState()
}

// ---------------------------------------------------------------------------
// nostrconnect QR pairing
// ---------------------------------------------------------------------------

let qrPollTimer = null

function stopQrPolling() {
  if (qrPollTimer) {
    clearTimeout(qrPollTimer)
    qrPollTimer = null
  }
}

function setQrStatus(msg, cls = '') {
  qrStatus.textContent = msg
  qrStatus.className = `qr-status ${cls}`.trim()
}

function resetQrFlow() {
  stopQrPolling()
  qrCode.innerHTML = ''
  qrUri.textContent = ''
  qrUri.style.display = 'none'
  qrActions.style.display = 'none'
  setQrStatus('')
  qrStartBtn.disabled = false
  qrStartBtn.textContent = 'Generate QR'
}

async function startQrPairing() {
  resetQrFlow()
  qrStartBtn.disabled = true
  qrStartBtn.textContent = 'Waiting...'

  let resp
  try {
    resp = await sendRuntimeMessage({ type: 'bark-nostrconnect-start', relays: qrRelayInput.value })
  } catch (err) {
    resp = { ok: false, error: err.message }
  }
  if (!resp?.ok) {
    setQrStatus(resp?.error || 'Could not start pairing.', 'err')
    qrStartBtn.disabled = false
    qrStartBtn.textContent = 'Generate QR'
    return
  }

  qrCode.innerHTML = renderSVG(resp.uri)
  qrUri.textContent = resp.uri
  qrUri.style.display = ''
  qrActions.style.display = ''
  setQrStatus('Scan with your signer, or paste the URI into it.')
  pollQrStatus()
}

async function pollQrStatus() {
  let status
  try {
    status = await sendRuntimeMessage({ type: 'bark-nostrconnect-status' })
  } catch {
    status = null
  }
  if (!status) {
    setQrStatus('Pairing expired. Generate a new QR.', 'err')
    qrStartBtn.disabled = false
    qrStartBtn.textContent = 'Generate QR'
    return
  }

  if (status.status === 'connected') {
    setQrStatus('Connected.', 'ok')
    await sendRuntimeMessage({ type: 'bark-nostrconnect-cancel' }).catch(() => {})
    resetQrFlow()
    qrFlow.style.display = 'none'
    qrShowBtn.style.display = ''
    await renderInstances()
    await refreshState()
    return
  }

  if (status.status === 'error') {
    setQrStatus(status.error || 'Pairing failed.', 'err')
    qrStartBtn.disabled = false
    qrStartBtn.textContent = 'Generate QR'
    return
  }

  qrPollTimer = setTimeout(pollQrStatus, 1000)
}

async function cancelQrPairing() {
  await sendRuntimeMessage({ type: 'bark-nostrconnect-cancel' }).catch(() => {})
  resetQrFlow()
  qrFlow.style.display = 'none'
  qrShowBtn.style.display = ''
}

/** Move the shared QR section into the main screen's add-signer area. */
function mountQrSectionInMainScreen() {
  if (qrHostMain && nostrconnectSection.parentElement !== qrHostMain) {
    qrHostMain.appendChild(nostrconnectSection)
  }
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

let retryCount = 0
let retryTimer = null
const RETRY_DELAYS = [5000, 10000, 20000]
const MAX_AUTO_RETRIES = 3

function clearRetryState() {
  retryCount = 0
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** Only http(s) auth URLs from the signer are opened in a tab. */
function safeAuthUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch { /* not a URL */ }
  return null
}

function showReconnecting(msg, autoRetrying, authUrl = null) {
  reconnectStatus.style.display = ''
  connectedContent.style.display = 'none'
  reconnectMsg.textContent = msg
  reconnectMsg.classList.toggle('active', autoRetrying)
  retryBtn.style.display = autoRetrying ? 'none' : ''
  statusDot.className = autoRetrying ? 'status-dot reconnecting' : 'status-dot'

  const safeUrl = safeAuthUrl(authUrl)
  authUrlBtn.style.display = safeUrl ? '' : 'none'
  authUrlBtn.dataset.url = safeUrl || ''
}

async function scheduleRetry() {
  if (retryCount >= MAX_AUTO_RETRIES) {
    showReconnecting('Connection lost.', false)
    return
  }
  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)]
  showReconnecting(`Reconnecting in ${delay / 1000}s...`, true)
  retryTimer = setTimeout(async () => {
    retryCount++
    await refreshState()
  }, delay)
}

// ---------------------------------------------------------------------------
// Relay display
// ---------------------------------------------------------------------------

function renderRelays(relays) {
  if (!relays || relays.length === 0) {
    relayInfo.style.display = 'none'
    return
  }
  relayInfo.style.display = ''
  const upCount = relays.filter((r) => r.connected).length
  relaySummary.textContent = `${upCount}/${relays.length} relays connected`

  relayDetails.innerHTML = ''
  for (const r of relays) {
    const item = document.createElement('div')
    item.className = 'relay-item'

    const dot = document.createElement('div')
    dot.className = 'relay-dot' + (r.connected ? ' up' : '')
    item.appendChild(dot)

    const url = document.createElement('span')
    // Show just the hostname for brevity
    try {
      url.textContent = new URL(r.url).hostname
    } catch {
      url.textContent = r.url
    }
    item.appendChild(url)

    relayDetails.appendChild(item)
  }
}

function formatTime(ms) {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function renderSigningStatus(status) {
  const state = status.signingStatus || 'untested'
  signStatusDot.className = `sign-status-dot ${state}`
  signTestBtn.disabled = state === 'pending'

  if (state === 'ready') {
    signStatusText.textContent = 'Signing ready'
    signStatusDetail.textContent = status.signingLastOkAt
      ? `Last tested ${formatTime(status.signingLastOkAt)}`
      : 'Signer returned a valid event.'
    signTestBtn.textContent = 'Test'
    return
  }

  if (state === 'pending') {
    signStatusText.textContent = 'Waiting for signer'
    signStatusDetail.textContent = 'Approve the request on your signer device.'
    signTestBtn.textContent = 'Waiting'
    return
  }

  if (state === 'error') {
    signStatusText.textContent = 'Signing failed'
    signStatusDetail.textContent = status.signingLastError || 'Run the sign test again.'
    signTestBtn.textContent = 'Retry'
    return
  }

  signStatusText.textContent = 'Signing not tested'
  signStatusDetail.textContent = 'Run a sign test before using sites.'
  signTestBtn.textContent = 'Test'
}

function identityPubkey(identity) {
  if (identity?.pubkey) return identity.pubkey
  if (identity?.npub) {
    try { return nip19.decode(identity.npub).data } catch { return '' }
  }
  return ''
}

function identityDisplayName(identity) {
  return identity?.personaName || identity?.name || identity?.purpose || identity?.label || 'master'
}

function instanceForIdentity(instances, identity) {
  const pk = identityPubkey(identity)
  if (!pk) return null
  return instances.find((instance) => (
    instance.heartwoodIdentityPubkey === pk ||
    instance.signingPubkey === pk ||
    (typeof instance.bunkerUri === 'string' && instance.bunkerUri.startsWith(`bunker://${pk}`))
  )) || null
}

async function refreshHeartwoodIdentityInstances(options = {}) {
  const result = await sendRuntimeMessage({
    type: 'bark-refresh-heartwood-identities',
    activatePubkey: options.activatePubkey || '',
    activateLabel: options.activateLabel || '',
  })
  if (!result || !result.ok) throw new Error(result?.error || 'Could not refresh Heartwood identities.')
  return result
}

// ---------------------------------------------------------------------------
// Core state refresh
// ---------------------------------------------------------------------------

async function refreshState() {
  let pubkey
  try {
    pubkey = await rpc('getPublicKey')
  } catch (err) {
    if (err.message.includes('No bunker URI') || err.message.includes('No Heartwood instance')) {
      showScreen(setupScreen)
      clearRetryState()
      return
    }
    // Check if we're awaiting approval rather than truly disconnected
    const status = await queryStatus()
    if (status.status === 'awaiting-approval') {
      showScreen(mainScreen)
      showReconnecting(
        status.lastError || 'Approve this connection on your signer.',
        false,
        status.authUrl,
      )
      retryBtn.textContent = 'Check again'
      retryBtn.style.display = ''
      renderRelays(status.relays)
      return
    }
    // Connection failed — show reconnection UI
    showScreen(mainScreen)
    renderRelays(status.relays)
    await scheduleRetry()
    return
  }

  // Connected — clear any retry state
  clearRetryState()

  // Query full status for relay info and Heartwood mode
  const status = await queryStatus()

  showScreen(mainScreen)
  reconnectStatus.style.display = 'none'
  connectedContent.style.display = ''
  statusDot.className = 'status-dot connected'

  // Render policy settings
  renderPolicies()

  // Heartwood badge
  heartwoodBadge.style.display = status.isHeartwood ? '' : 'none'

  // Relay info
  renderRelays(status.relays)
  renderSigningStatus(status)

  // Active persona
  activeNpub.textContent = truncateNpub(pubkey)

  if (status.isHeartwood) {
    // Heartwood mode — show full persona UI
    personaSection.style.display = ''
    standardBunkerCard.style.display = 'none'

    const { instances = [], activeInstanceId } = await storageGet([
      'instances',
      'activeInstanceId',
    ])
    const activeInstance = instances.find(instance => instance.id === activeInstanceId)
    const heartwoodInstances = instances.filter((instance) => (
      instance.isHeartwood &&
      instance.heartwoodIdentityPubkey &&
      (
        (activeInstance?.address && instance.address === activeInstance.address) ||
        instance.id === activeInstanceId
      )
    ))

    let identities = []
    try {
      const result = await rpc('heartwood_list_identities')
      if (Array.isArray(result)) identities = result
    } catch (err) {
      showError('Could not load personas: ' + err.message)
    }

    const activeMatch = identities.find((id) => {
      return identityPubkey(id) === pubkey
    })
    const activeInstanceName = activeInstance?.heartwoodIdentityLabel || activeInstance?.name
    activeName.textContent = activeInstanceName || (activeMatch ? identityDisplayName(activeMatch) : 'master')

    // Render imported Heartwood bunkers first. Latest Heartwood exposes one
    // bunker URI per identity; selecting the persona means selecting that URI.
    personaList.innerHTML = ''

    const renderedPubkeys = new Set()
    const sortedHeartwoodInstances = [...heartwoodInstances].sort((a, b) => {
      if (a.heartwoodIdentityLabel === 'master') return -1
      if (b.heartwoodIdentityLabel === 'master') return 1
      return String(a.heartwoodIdentityLabel || a.name).localeCompare(String(b.heartwoodIdentityLabel || b.name))
    })

    for (const instance of sortedHeartwoodInstances) {
      renderedPubkeys.add(instance.heartwoodIdentityPubkey)
      const item = document.createElement('div')
      item.className = 'persona-item' + (instance.id === activeInstanceId ? ' active' : '')

      const name = document.createElement('div')
      name.className = 'persona-name'
      name.textContent = instance.heartwoodIdentityLabel || instance.name || 'unnamed'
      item.appendChild(name)

      const npub = document.createElement('div')
      npub.className = 'persona-npub'
      npub.textContent = truncateNpub(instance.npub || instance.heartwoodIdentityPubkey)
      item.appendChild(npub)

      item.addEventListener('click', () => {
        if (instance.id !== activeInstanceId) switchInstance(instance.id)
      })
      personaList.appendChild(item)
    }

    for (const id of identities) {
      const pk = identityPubkey(id)
      if (renderedPubkeys.has(pk)) continue
      const targetInstance = instanceForIdentity(instances, id)
      const displayName = identityDisplayName(id)
      const switchTarget = id.personaName || id.name || id.purpose || id.npub || id.pubkey
      const isActive = pk === pubkey || targetInstance?.id === activeInstanceId
      const item = document.createElement('div')
      item.className = 'persona-item' + (isActive ? ' active' : '')

      const name = document.createElement('div')
      name.className = 'persona-name'
      name.textContent = displayName
      item.appendChild(name)

      const npub = document.createElement('div')
      npub.className = 'persona-npub'
      npub.textContent = truncateNpub(id.npub || pk)
      item.appendChild(npub)

      item.addEventListener('click', () => {
        if (targetInstance) switchInstance(targetInstance.id)
        else switchPersona(switchTarget)
      })
      personaList.appendChild(item)
    }
  } else {
    // Standard bunker mode — show greyed persona card
    personaSection.style.display = 'none'
    standardBunkerCard.style.display = ''
    activeName.textContent = 'default'
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function switchPersona(target) {
  try {
    await rpc('heartwood_switch', { target })
    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

async function derivePersona() {
  const purpose = deriveInput.value.trim()
  if (!purpose) return

  try {
    const derived = await rpc('heartwood_derive', { purpose, index: 0 })
    const derivedPubkey = derived?.pubkey || ''

    try {
      await refreshHeartwoodIdentityInstances({
        activatePubkey: derivedPubkey,
        activateLabel: purpose,
      })
    } catch {
      const identities = await rpc('heartwood_list_identities')
      const match = Array.isArray(identities)
        ? identities.find((id) => id.purpose === purpose || id.name === purpose || id.personaName === purpose)
        : null
      if (match) {
        const switchTarget = match.personaName || match.name || match.purpose || match.npub
        await rpc('heartwood_switch', { target: switchTarget })
      }
    }

    deriveInput.value = ''
    await renderInstances()
    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

async function testSigner() {
  signTestBtn.disabled = true
  signTestBtn.textContent = 'Waiting'
  signStatusDot.className = 'sign-status-dot pending'
  signStatusText.textContent = 'Waiting for signer'
  signStatusDetail.textContent = 'Approve the request on your signer device.'

  try {
    await primeSigner()
  } catch (err) {
    showError(err.message)
  } finally {
    await refreshState()
  }
}

function showConnectStatus(msg, connecting = false) {
  connectStatus.textContent = msg
  connectStatus.classList.toggle('visible', !!msg)
  connectStatus.classList.toggle('connecting', connecting)
}

async function disconnect() {
  try {
    await storageRemove(['instances', 'activeInstanceId'])
    await sendRuntimeMessage({ type: 'bark-reset' })
    clearRetryState()
    showScreen(setupScreen)
    statusDot.className = 'status-dot'
  } catch (err) {
    showError(err.message)
  }
}

// ---------------------------------------------------------------------------
// Policy settings
// ---------------------------------------------------------------------------

const KIND_NAMES = {
  0: 'Profile metadata',
  3: 'Contact list',
  10002: 'Relay list',
}

async function loadPolicies() {
  const { policies } = await storageGet('policies')
  const normalised = normalisePolicies(policies)
  if (policies && policies.version !== normalised.version) {
    await storageSet({ policies: normalised })
  }
  return normalised
}

async function savePolicies(policies) {
  await storageSet({ policies })
}

function renderKindRules(policies) {
  kindRulesList.innerHTML = ''
  const entries = Object.entries(policies.kindRules || {})
  if (entries.length === 0) {
    const placeholder = document.createElement('div')
    placeholder.className = 'policy-placeholder'
    placeholder.textContent = 'No kind rules configured'
    kindRulesList.appendChild(placeholder)
    return
  }
  for (const [kind, action] of entries) {
    const item = document.createElement('div')
    item.className = 'policy-item'

    const label = document.createElement('span')
    label.className = 'policy-label'
    const name = KIND_NAMES[Number(kind)] || `Kind ${kind}`
    label.innerHTML = `${escapeHtml(name)} <span class="policy-kind-num">${escapeHtml(kind)}</span>`
    item.appendChild(label)

    const actionSpan = document.createElement('span')
    actionSpan.className = `policy-action ${escapeHtml(action)}`
    actionSpan.textContent = action
    item.appendChild(actionSpan)

    const removeBtn = document.createElement('button')
    removeBtn.className = 'policy-remove'
    removeBtn.textContent = '×'
    removeBtn.dataset.kind = kind
    removeBtn.addEventListener('click', async () => {
      const current = await loadPolicies()
      delete current.kindRules[kind]
      await savePolicies(current)
      renderKindRules(current)
    })
    item.appendChild(removeBtn)

    kindRulesList.appendChild(item)
  }
}

function renderSiteRules(policies) {
  siteRulesList.innerHTML = ''
  const entries = Object.entries(policies.siteRules || {})
  if (entries.length === 0) {
    const placeholder = document.createElement('div')
    placeholder.className = 'policy-placeholder'
    placeholder.textContent = 'No site rules configured'
    siteRulesList.appendChild(placeholder)
    return
  }
  for (const [origin, rule] of entries) {
    let hostname = origin
    try {
      hostname = new URL(origin).hostname
    } catch {
      // fall back to raw origin
    }

    const item = document.createElement('div')
    item.className = 'policy-item'

    const label = document.createElement('span')
    label.className = 'policy-label'
    label.title = origin
    label.textContent = hostname
    item.appendChild(label)

    const actionSpan = document.createElement('span')
    const displayAction = rule.signEvent || 'allow'
    actionSpan.className = `policy-action ${escapeHtml(displayAction)}`
    actionSpan.textContent = displayAction
    item.appendChild(actionSpan)

    const removeBtn = document.createElement('button')
    removeBtn.className = 'policy-remove'
    removeBtn.textContent = '×'
    removeBtn.dataset.origin = origin
    removeBtn.addEventListener('click', async () => {
      const current = await loadPolicies()
      delete current.siteRules[origin]
      await savePolicies(current)
      renderSiteRules(current)
    })
    item.appendChild(removeBtn)

    siteRulesList.appendChild(item)
  }
}

async function renderPolicies() {
  const policies = await loadPolicies()
  renderKindRules(policies)
  renderSiteRules(policies)
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

disconnectBtn.addEventListener('click', disconnect)
deriveBtn.addEventListener('click', derivePersona)
signTestBtn.addEventListener('click', testSigner)
retryBtn.addEventListener('click', () => {
  clearRetryState()
  retryBtn.textContent = 'Retry'
  refreshState()
})

authUrlBtn.addEventListener('click', () => {
  const url = safeAuthUrl(authUrlBtn.dataset.url)
  if (!url) return
  if (callbackApi?.tabs?.create) callbackApi.tabs.create({ url })
  else if (promiseApi?.tabs?.create) promiseApi.tabs.create({ url })
})

// Toggle relay details
relaySummary.addEventListener('click', () => {
  relayInfo.classList.toggle('expanded')
})

deriveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') derivePersona()
})

// Instance pairing and management
if (pairBtn) {
  pairBtn.addEventListener('click', () => pairHeartwood(heartwoodAddress.value.trim()))
}
if (heartwoodAddress) {
  heartwoodAddress.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pairHeartwood(heartwoodAddress.value.trim())
  })
}

if (showAddBtn) {
  showAddBtn.addEventListener('click', () => {
    addInstanceSection.style.display = ''
    showAddBtn.style.display = 'none'
    mountQrSectionInMainScreen()
    addAddressInput.focus()
  })
}

// nostrconnect QR pairing
qrShowBtn.addEventListener('click', () => {
  qrShowBtn.style.display = 'none'
  qrFlow.style.display = ''
})
qrStartBtn.addEventListener('click', startQrPairing)
qrCancelBtn.addEventListener('click', cancelQrPairing)
qrCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(qrUri.textContent)
    setQrStatus('URI copied.', 'ok')
  } catch {
    setQrStatus('Copy failed.', 'err')
  }
})

if (addPairBtn) {
  addPairBtn.addEventListener('click', () => pairHeartwood(addAddressInput.value.trim()))
}
if (addAddressInput) {
  addAddressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pairHeartwood(addAddressInput.value.trim())
  })
}

// Policy toggle
policyToggle.addEventListener('click', () => {
  const visible = policyContent.style.display !== 'none'
  policyContent.style.display = visible ? 'none' : ''
  policyArrow.innerHTML = visible ? '&#9654;' : '&#9660;'
})

// Add kind rule
async function addKindRule() {
  const raw = addKindInput.value.trim()
  const num = Number(raw)
  if (!raw || isNaN(num) || !Number.isInteger(num) || num < 0 || num > 65535) return
  const policies = await loadPolicies()
  policies.kindRules[String(num)] = 'ask'
  await savePolicies(policies)
  renderKindRules(policies)
  addKindInput.value = ''
}

addKindBtn.addEventListener('click', addKindRule)
addKindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addKindRule()
})

// Add site rule
async function addSiteRule() {
  let raw = addSiteInput.value.trim()
  if (!raw) return
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) raw = 'https://' + raw
  let origin
  try {
    origin = new URL(raw).origin
  } catch {
    return
  }
  const action = addSiteAction.value || 'allow'
  const policies = await loadPolicies()
  policies.siteRules[origin] = {
    getRelays: action,
    signEvent: action,
    'nip04.encrypt': action,
    'nip04.decrypt': action,
    getPublicKey: action,
    'nip44.encrypt': action,
    'nip44.decrypt': action,
  }
  await savePolicies(policies)
  renderSiteRules(policies)
  addSiteInput.value = ''
}

addSiteBtn.addEventListener('click', addSiteRule)
addSiteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSiteRule()
})

// Reset policies
resetPoliciesBtn.addEventListener('click', async () => {
  if (!confirm('Reset all policy rules to defaults?')) return
  await storageRemove('policies')
  await renderPolicies()
})

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

renderInstances().then((hasInstances) => {
  if (hasInstances) return refreshState()
}).catch((err) => {
  showError(err.message)
})

setInterval(async () => {
  if (!mainScreen.classList.contains('active')) return
  const status = await queryStatus()
  renderSigningStatus(status)
}, 2500)
