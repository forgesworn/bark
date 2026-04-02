// Approval popup logic — queries background for pending request details,
// renders them, and sends the user's allow/deny decision back.

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
  chrome.runtime.sendMessage(
    { type: 'bark-approval-response', requestId, decision },
    () => window.close(),
  )
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function init() {
  if (!requestId) {
    loading.textContent = 'Missing request ID.'
    return
  }

  chrome.runtime.sendMessage(
    { type: 'bark-approval-query', requestId },
    (details) => {
      if (chrome.runtime.lastError || !details) {
        loading.textContent = 'Request not found or expired.'
        return
      }

      loading.style.display = 'none'
      content.style.display = ''

      // Set title and origin based on request type
      if (details.method === 'getPublicKey') {
        title.textContent = 'Identity Request'
        originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to know your identity'
      } else if (details.method === 'signEvent') {
        title.textContent = 'Profile Update Request'
        originText.innerHTML = '<strong>' + escapeHtml(details.origin) + '</strong> wants to update your profile'
        if (details.event && details.event.content) {
          renderProfileFields(details.event.content)
        }
      }

      // Persona info
      personaName.textContent = details.personaName || 'default'
      personaNpub.textContent = truncate(details.pubkey)

      // Focus deny button for safety (Enter = deny)
      denyBtn.focus()
    },
  )
}

allowBtn.addEventListener('click', () => sendDecision('allow'))
denyBtn.addEventListener('click', () => sendDecision('deny'))

// Keyboard: Escape = deny
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sendDecision('deny')
})

init()
