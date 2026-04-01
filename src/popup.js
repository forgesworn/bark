// Popup UI logic — persona management, Heartwood detection, relay display.

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const setupScreen = document.getElementById('setup-screen')
const mainScreen = document.getElementById('main-screen')
const bunkerInput = document.getElementById('bunker-input')
const connectBtn = document.getElementById('connect-btn')
const statusDot = document.getElementById('status-dot')
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
    // Connection failed — show reconnection UI
    showScreen(mainScreen)
    const status = await queryStatus()
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
    } catch {
      // Heartwood detected at connect time but list failed — show empty
    }

    let activeLabel = 'default'
    if (identities.length > 0) {
      const match = identities.find((id) => id.pubkey === pubkey)
      activeLabel = match?.name || match?.purpose || 'default'
    }
    activeName.textContent = activeLabel

    // Render persona list
    personaList.innerHTML = ''
    for (const id of identities) {
      const item = document.createElement('div')
      item.className = 'persona-item' + (id.pubkey === pubkey ? ' active' : '')

      const name = document.createElement('div')
      name.className = 'persona-name'
      name.textContent = id.name || id.purpose || 'unnamed'
      item.appendChild(name)

      const npub = document.createElement('div')
      npub.className = 'persona-npub'
      npub.textContent = truncateNpub(id.pubkey)
      item.appendChild(npub)

      item.addEventListener('click', () => switchPersona(id.pubkey))
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

async function switchPersona(pubkey) {
  try {
    await rpc('heartwood_switch', { pubkey })
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
      ? identities.find((id) => id.purpose === purpose || id.name === purpose)
      : null

    if (derived) {
      await rpc('heartwood_switch', { pubkey: derived.pubkey })
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

async function connect() {
  const uri = bunkerInput.value.trim()
  if (!uri) return

  if (!isValidBunkerUri(uri)) {
    showError('Invalid bunker URI. Expected format: bunker://<64-hex-pubkey>?relay=...')
    return
  }

  connectBtn.disabled = true
  connectBtn.textContent = 'Connecting...'
  showConnectStatus('Reaching Heartwood via relays...', true)

  try {
    await chrome.storage.local.set({ bunkerUri: uri })

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bark-reset' }, resolve)
    })

    showConnectStatus('Verifying identity...', true)
    await refreshState()
    showConnectStatus('')
  } catch (err) {
    showError(err.message)
    showConnectStatus('')
  } finally {
    connectBtn.disabled = false
    connectBtn.textContent = 'Connect'
  }
}

async function disconnect() {
  try {
    await chrome.storage.local.remove(['bunkerUri', 'clientSecret', 'isHeartwood'])
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bark-reset' }, resolve)
    })
    clearRetryState()
    showScreen(setupScreen)
    bunkerInput.value = ''
    statusDot.className = 'status-dot'
  } catch (err) {
    showError(err.message)
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

connectBtn.addEventListener('click', connect)
disconnectBtn.addEventListener('click', disconnect)
deriveBtn.addEventListener('click', derivePersona)
retryBtn.addEventListener('click', () => {
  clearRetryState()
  refreshState()
})

// Toggle relay details
relaySummary.addEventListener('click', () => {
  relayInfo.classList.toggle('expanded')
})

bunkerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect()
})
deriveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') derivePersona()
})

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

refreshState().catch((err) => {
  showError(err.message)
})
