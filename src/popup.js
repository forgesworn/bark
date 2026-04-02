// Popup UI logic — persona management, Heartwood detection, relay display.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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

/** Validate that a string looks like a valid bunker URI. */
function isValidBunkerUri(value) {
  return typeof value === 'string' && /^bunker:\/\/[0-9a-f]{64}\??[?/\w:.=&%-]*$/.test(value)
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
    return `<div class="${cardClass}" data-id="${inst.id}">
      <span class="inst-status ${statusClass}"></span>
      <div style="flex:1; min-width:0;">
        <div class="inst-name">${escapeHtml(inst.name)}</div>
        <div class="inst-npub">${escapeHtml(npubShort)}</div>
      </div>
      <button class="inst-remove" data-id="${inst.id}" title="Remove">&times;</button>
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

    let activeLabel = 'default'
    if (identities.length > 0) {
      const match = identities.find((id) => (id.pubkey || id.npub) === pubkey)
      activeLabel = match?.name || match?.personaName || match?.purpose || 'default'
    }
    activeName.textContent = activeLabel

    // Render persona list
    personaList.innerHTML = ''
    for (const id of identities) {
      const pk = id.pubkey || id.npub
      const item = document.createElement('div')
      item.className = 'persona-item' + (pk === pubkey ? ' active' : '')

      const name = document.createElement('div')
      name.className = 'persona-name'
      name.textContent = id.name || id.personaName || id.purpose || 'unnamed'
      item.appendChild(name)

      const npub = document.createElement('div')
      npub.className = 'persona-npub'
      npub.textContent = truncateNpub(pk)
      item.appendChild(npub)

      item.addEventListener('click', () => switchPersona(pk))
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
      await rpc('heartwood_switch', { target: derived.pubkey || derived.npub })
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

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

renderInstances().then(() => refreshState()).catch((err) => {
  showError(err.message)
})
