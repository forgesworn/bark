// Popup UI logic — persona management, Heartwood detection, relay display.

import { nip19 } from 'nostr-tools'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
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
const reconnectStatus = document.getElementById('reconnect-status')
const reconnectMsg = document.getElementById('reconnect-msg')
const retryBtn = document.getElementById('retry-btn')
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

// Policy defaults (must match src/policy.js)
const DEFAULT_POLICIES = {
  defaults: { getPublicKey: 'allow', signEvent: 'allow', 'nip44.encrypt': 'allow', 'nip44.decrypt': 'allow' },
  kindRules: { '0': 'ask', '3': 'ask', '10002': 'ask' },
  siteRules: {},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send an RPC request to the background service worker. */
async function rpc(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'bark-request', method, params },
      (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (result && result.error) {
          reject(new Error(result.error))
          return
        }
        resolve(result)
      },
    )
  })
}

/** Query connection state from the background worker. */
async function queryStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'bark-status' }, (result) => {
      if (chrome.runtime.lastError) {
        resolve({
          status: 'disconnected',
          lastError: 'Extension error',
          relays: [],
          isHeartwood: false,
        })
        return
      }
      resolve(result || { status: 'disconnected', lastError: null, relays: [], isHeartwood: false })
    })
  })
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

/** Switch visible screen. */
function showScreen(screen) {
  setupScreen.classList.remove('active')
  mainScreen.classList.remove('active')
  screen.classList.add('active')
}

// ---------------------------------------------------------------------------
// Instance card rendering and actions
// ---------------------------------------------------------------------------

/** Render the instance card list from storage. */
async function renderInstances() {
  const { instances = [], activeInstanceId } = await chrome.storage.local.get([
    'instances', 'activeInstanceId',
  ])

  if (instances.length === 0) {
    showScreen(setupScreen)
    return
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
}

async function pairHeartwood(address) {
  if (!address) {
    pairError.textContent = 'Enter a Heartwood address (e.g. heartwood.local:3000)'
    pairError.classList.remove('hidden')
    return
  }
  pairError.classList.add('hidden')
  const btn = document.activeElement === addPairBtn ? addPairBtn : pairBtn
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = 'Connecting...'

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bark-pair', address }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (!resp) {
          reject(new Error('No response from background — try reloading the extension'))
        } else if (!resp.ok) {
          reject(new Error(resp.error || 'Pairing failed'))
        } else {
          resolve(resp)
        }
      })
    })

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

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'bark-switch', instanceId }, resolve)
  })

  if (!result.ok) showError(result.error)
  await renderInstances()
  await refreshState()
}

async function removeInstance(instanceId) {
  if (!confirm('Remove this Heartwood instance?')) return

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'bark-remove', instanceId }, resolve)
  })

  if (!result.ok) {
    showError(result.error)
    return
  }
  await renderInstances()
  if (result.remaining > 0) await refreshState()
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

function showReconnecting(msg, autoRetrying) {
  reconnectStatus.style.display = ''
  connectedContent.style.display = 'none'
  reconnectMsg.textContent = msg
  reconnectMsg.classList.toggle('active', autoRetrying)
  retryBtn.style.display = autoRetrying ? 'none' : ''
  statusDot.className = autoRetrying ? 'status-dot reconnecting' : 'status-dot'
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

// ---------------------------------------------------------------------------
// Core state refresh
// ---------------------------------------------------------------------------

async function refreshState() {
  let pubkey
  try {
    pubkey = await rpc('getPublicKey')
  } catch (err) {
    if (err.message.includes('No bunker URI')) {
      showScreen(setupScreen)
      clearRetryState()
      return
    }
    // Check if we're awaiting approval rather than truly disconnected
    const status = await queryStatus()
    if (status.status === 'awaiting-approval') {
      showScreen(mainScreen)
      showReconnecting('Approve this client on your Heartwood device.', false)
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

  // Active persona
  activeNpub.textContent = truncateNpub(pubkey)

  if (status.isHeartwood) {
    // Heartwood mode — show full persona UI
    personaSection.style.display = ''
    standardBunkerCard.style.display = 'none'

    let identities = []
    try {
      const result = await rpc('heartwood_list_identities')
      if (Array.isArray(result)) identities = result
    } catch (err) {
      showError('Could not load personas: ' + err.message)
    }

    const activeMatch = identities.find((id) => {
      if (id.pubkey) return id.pubkey === pubkey
      if (id.npub) {
        try { return nip19.decode(id.npub).data === pubkey } catch { return false }
      }
      return false
    })
    const onMaster = !activeMatch
    activeName.textContent = activeMatch
      ? (activeMatch.personaName || activeMatch.name || activeMatch.purpose || 'default')
      : 'master'

    // Render persona list — master first, then derived identities
    personaList.innerHTML = ''

    const masterItem = document.createElement('div')
    masterItem.className = 'persona-item' + (onMaster ? ' active' : '')
    const masterName = document.createElement('div')
    masterName.className = 'persona-name'
    masterName.textContent = 'master'
    masterItem.appendChild(masterName)
    masterItem.addEventListener('click', () => switchPersona('master'))
    personaList.appendChild(masterItem)

    for (const id of identities) {
      const pk = id.pubkey || id.npub
      const displayName = id.personaName || id.name || id.purpose || 'unnamed'
      const switchTarget = id.personaName || id.name || id.purpose || pk
      const isActive = !onMaster && !!activeMatch && (id === activeMatch)
      const item = document.createElement('div')
      item.className = 'persona-item' + (isActive ? ' active' : '')

      const name = document.createElement('div')
      name.className = 'persona-name'
      name.textContent = displayName
      item.appendChild(name)

      const npub = document.createElement('div')
      npub.className = 'persona-npub'
      npub.textContent = truncateNpub(pk)
      item.appendChild(npub)

      item.addEventListener('click', () => switchPersona(switchTarget))
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
    await rpc('heartwood_derive', { purpose, index: 0 })
    const identities = await rpc('heartwood_list_identities')
    const derived = Array.isArray(identities)
      ? identities.find((id) => id.purpose === purpose || id.name === purpose || id.personaName === purpose)
      : null

    if (derived) {
      const switchTarget = derived.personaName || derived.name || derived.purpose || derived.npub
      await rpc('heartwood_switch', { target: switchTarget })
    }

    deriveInput.value = ''
    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

function showConnectStatus(msg, connecting = false) {
  connectStatus.textContent = msg
  connectStatus.classList.toggle('visible', !!msg)
  connectStatus.classList.toggle('connecting', connecting)
}

async function disconnect() {
  try {
    await chrome.storage.local.remove(['instances', 'activeInstanceId'])
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bark-reset' }, resolve)
    })
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
  const { policies } = await chrome.storage.local.get('policies')
  return policies || DEFAULT_POLICIES
}

async function savePolicies(policies) {
  await chrome.storage.local.set({ policies })
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
retryBtn.addEventListener('click', () => {
  clearRetryState()
  retryBtn.textContent = 'Retry'
  refreshState()
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
    addAddressInput.focus()
  })
}

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
    signEvent: action,
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
  await chrome.storage.local.remove('policies')
  await renderPolicies()
})

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

renderInstances().then(() => refreshState()).catch((err) => {
  showError(err.message)
})
