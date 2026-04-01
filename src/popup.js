// Popup UI logic — persona management and Heartwood connection.

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const setupScreen = document.getElementById('setup-screen')
const mainScreen = document.getElementById('main-screen')
const bunkerInput = document.getElementById('bunker-input')
const connectBtn = document.getElementById('connect-btn')
const statusDot = document.getElementById('status-dot')
const activeName = document.getElementById('active-name')
const activeNpub = document.getElementById('active-npub')
const personaList = document.getElementById('persona-list')
const deriveInput = document.getElementById('derive-input')
const deriveBtn = document.getElementById('derive-btn')
const disconnectBtn = document.getElementById('disconnect-btn')
const errorMsg = document.getElementById('error-msg')

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
// Core actions
// ---------------------------------------------------------------------------

/**
 * Fetch current state from the background and render the main screen.
 * If the bunker is not configured, show the setup screen instead.
 */
async function refreshState() {
  let pubkey
  try {
    pubkey = await rpc('getPublicKey')
  } catch (err) {
    if (err.message.includes('No bunker URI')) {
      showScreen(setupScreen)
      return
    }
    throw err
  }

  // We have a connection — show main screen
  showScreen(mainScreen)
  statusDot.classList.add('connected')

  // Try to list Heartwood identities; gracefully degrade for standard
  // NIP-46 bunkers that do not support the heartwood_ methods.
  let identities = []
  try {
    const result = await rpc('heartwood_list_identities')
    if (Array.isArray(result)) {
      identities = result
    }
  } catch {
    // Non-Heartwood bunker — just show default persona
  }

  // Determine active persona details
  let activeLabel = 'default'
  if (identities.length > 0) {
    const match = identities.find((id) => id.pubkey === pubkey)
    activeLabel = match?.name || match?.purpose || 'default'
  }

  activeName.textContent = activeLabel
  activeNpub.textContent = truncateNpub(pubkey)

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
}

/** Switch to a different persona. */
async function switchPersona(pubkey) {
  try {
    await rpc('heartwood_switch', { pubkey })
    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

/** Derive a new persona from the purpose input, switch to it. */
async function derivePersona() {
  const purpose = deriveInput.value.trim()
  if (!purpose) return

  try {
    await rpc('heartwood_derive', { purpose, index: 0 })
    // Switch to the newly derived persona by purpose — the bunker should
    // have returned the new identity which we can find after listing.
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

/** Save the bunker URI, reset the connection, and refresh. */
async function connect() {
  const uri = bunkerInput.value.trim()
  if (!uri) return

  try {
    await chrome.storage.local.set({ bunkerUri: uri })

    // Reset any stale connection so background picks up the new URI
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bark-reset' }, resolve)
    })

    await refreshState()
  } catch (err) {
    showError(err.message)
  }
}

/** Clear stored credentials, reset connection, and return to setup. */
async function disconnect() {
  try {
    await chrome.storage.local.remove(['bunkerUri', 'clientSecret'])
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bark-reset' }, resolve)
    })
    showScreen(setupScreen)
    bunkerInput.value = ''
    statusDot.classList.remove('connected')
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

// Allow Enter key on inputs
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
