// Approval popup logic — queries background for pending request details,
// renders them, and sends the user's allow/deny decision back.

const callbackApi = globalThis.chrome
const promiseApi = globalThis.browser && !globalThis.chrome ? globalThis.browser : null

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

const loading = document.getElementById('loading')
const content = document.getElementById('content')
const title = document.getElementById('title')
const errorDiv = document.getElementById('error')
const originText = document.getElementById('origin-text')
const personaName = document.getElementById('persona-name')
const personaNpub = document.getElementById('persona-npub')
const profileSection = document.getElementById('profile-section')
const profileFields = document.getElementById('profile-fields')
const allowBtn = document.getElementById('allow-btn')
const trustBtn = document.getElementById('trust-btn')
const denyBtn = document.getElementById('deny-btn')

// Extract requestId from URL params
const params = new URLSearchParams(window.location.search)
const requestId = params.get('requestId')

function truncate(hex) {
  if (!hex || hex.length <= 20) return hex || ''
  return hex.slice(0, 8) + '...' + hex.slice(-8)
}

function showError(msg) {
  errorDiv.textContent = msg
  errorDiv.classList.add('visible')
}

function renderProfileFields(contentJson) {
  const displayFields = ['name', 'display_name', 'about', 'picture', 'nip05', 'lud16']
  let parsed
  try {
    parsed = JSON.parse(contentJson)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return

  let hasFields = false
  for (const key of displayFields) {
    const val = parsed[key]
    if (!val || typeof val !== 'string') continue
    hasFields = true

    const field = document.createElement('div')
    field.className = 'profile-field'

    const label = document.createElement('div')
    label.className = 'field-label'
    label.textContent = key

    const value = document.createElement('div')
    value.className = 'field-value'
    value.textContent = val

    field.appendChild(label)
    field.appendChild(value)
    profileFields.appendChild(field)
  }

  if (hasFields) {
    profileSection.style.display = ''
  }
}

function sendDecision(decision) {
  sendRuntimeMessage({ type: 'bark-approval-response', requestId, decision })
    .finally(() => window.close())
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

async function init() {
  if (!requestId) {
    loading.textContent = 'Missing request ID.'
    return
  }

  let details
  try {
    details = await sendRuntimeMessage({ type: 'bark-approval-query', requestId })
  } catch {
    details = null
  }
  if (!details) {
    loading.textContent = 'Request not found or expired.'
    return
  }

  loading.style.display = 'none'
  content.style.display = ''

  // Method-specific title and description
  const kindNames = {
    0: 'Profile Metadata',
    3: 'Contact List',
    10002: 'Relay List',
  }

  if (details.method === 'signEvent' && details.event) {
    const kind = details.event.kind
    const kindLabel = kindNames[kind] || `Kind ${kind}`
    title.textContent = `Sign ${kindLabel}?`
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to sign a ' + escapeHtml(kindLabel) + ' event'
    if (kind === 0 && details.event.content) {
      renderProfileFields(details.event.content)
    }
  } else if (details.method === 'getPublicKey') {
    title.textContent = 'Share Identity?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to know your public key'
  } else if (details.method === 'getRelays') {
    title.textContent = 'Share Relays?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to know your relay list'
  } else if (details.method === 'nip04.encrypt') {
    title.textContent = 'Encrypt Message?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to encrypt a legacy message'
  } else if (details.method === 'nip04.decrypt') {
    title.textContent = 'Decrypt Message?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to decrypt a legacy message'
  } else if (details.method === 'nip44.encrypt') {
    title.textContent = 'Encrypt Message?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to encrypt a message'
  } else if (details.method === 'nip44.decrypt') {
    title.textContent = 'Decrypt Message?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to decrypt a message'
  } else if (details.method === 'heartwood_list_identities') {
    title.textContent = 'List Identities?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to list the identities on your Heartwood device'
  } else if (details.method === 'heartwood_derive' || details.method === 'heartwood_derive_persona') {
    title.textContent = 'Derive Identity?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to derive a new identity on your Heartwood device'
  } else if (details.method === 'heartwood_switch') {
    title.textContent = 'Switch Identity?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to switch your active signing identity'
  } else {
    title.textContent = 'Approve Request?'
    originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to call <code>' + escapeHtml(details.method) + '</code>'
  }

  // Persona info
  personaName.textContent = details.personaName || 'default'
  personaNpub.textContent = truncate(details.pubkey)
  trustBtn.style.display = details.canTrustSite ? '' : 'none'

  // Focus deny button for safety (Enter = deny)
  denyBtn.focus()
}

allowBtn.addEventListener('click', () => sendDecision('allow-once'))
trustBtn.addEventListener('click', () => sendDecision('allow-site'))
denyBtn.addEventListener('click', () => sendDecision('deny'))

// Keyboard: Escape = deny
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sendDecision('deny')
})

init()
