// Approval popup logic — queries background for pending request details,
// renders them, and sends the user's allow/deny decision back.

import { localiseDocument, t } from './i18n.js'
import { npubEncode } from 'nostr-tools/nip19'

const callbackApi = globalThis.chrome
const promiseApi = globalThis.browser && !globalThis.chrome ? globalThis.browser : null

localiseDocument()

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
const personaFullKey = document.getElementById('persona-full-key')
const requestPreview = document.getElementById('request-preview')
const requestContent = document.getElementById('request-content')
const requestWarning = document.getElementById('request-warning')
const requestHint = document.getElementById('request-hint')
const eventDetails = document.getElementById('event-details')
const eventJson = document.getElementById('event-json')
const profileSection = document.getElementById('profile-section')
const profileFields = document.getElementById('profile-fields')
const allowBtn = document.getElementById('allow-btn')
const trustBtn = document.getElementById('trust-btn')
const trustSection = document.getElementById('trust-section')
const denyBtn = document.getElementById('deny-btn')
const approvalTime = document.getElementById('approval-time')
const approvalTimeWarning = document.getElementById('approval-time-warning')
let expiresAt = null
let expiryTimer = null

function reviewExpired() {
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt
}

function updateReviewTime() {
  if (!Number.isFinite(expiresAt)) return
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  approvalTime.textContent = t('approvalTimeRemaining', [String(remaining)])
  approvalTime.style.display = ''
  if (remaining <= 30) {
    approvalTimeWarning.style.display = ''
    const message = remaining === 0 ? t('approvalExpired') : t('approvalTimeWarning')
    if (approvalTimeWarning.textContent !== message) approvalTimeWarning.textContent = message
  }
  if (remaining === 0) {
    allowBtn.disabled = true
    trustBtn.disabled = true
    clearInterval(expiryTimer)
  }
}

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

let sendingDecision = false
function sendDecision(decision) {
  if (reviewExpired()) {
    updateReviewTime()
    if (decision === 'deny') window.close()
    return
  }
  if (sendingDecision) return
  const focused = document.activeElement
  sendingDecision = true
  for (const button of [allowBtn, trustBtn, denyBtn]) button.disabled = true
  sendRuntimeMessage({ type: 'bark-approval-response', requestId, decision })
    .then((result) => {
      if (result?.ok !== true) throw new Error(result?.error || 'Decision not acknowledged.')
      window.close()
    })
    .catch(() => {
      showError(t('approvalDecisionFailed'))
      sendingDecision = false
      for (const button of [allowBtn, trustBtn, denyBtn]) button.disabled = false
      updateReviewTime()
      if (document.activeElement === document.body && [allowBtn, trustBtn, denyBtn].includes(focused)) {
        ;(focused.disabled ? denyBtn : focused).focus()
      }
    })
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

async function init() {
  if (!requestId) {
    loading.textContent = t('missingRequestId')
    return
  }

  let details
  try {
    details = await sendRuntimeMessage({ type: 'bark-approval-query', requestId })
  } catch {
    details = null
  }
  if (!details) {
    loading.textContent = t('requestNotFound')
    return
  }

  loading.style.display = 'none'
  content.style.display = ''

  // Method-specific title and description
  const kindNames = {
    0: t('approveKindProfile'),
    1: t('approveKindNote'),
    3: t('approveKindContacts'),
    4: t('approveKindEncryptedMessage'),
    5: t('approveKindDeletion'),
    6: t('approveKindRepost'),
    7: t('approveKindReaction'),
    1059: t('approveKindEncryptedEnvelope'),
    10002: t('approveKindRelays'),
    22242: t('approveKindRelayAuth'),
    30023: t('approveKindArticle'),
    // V4V gated content (Pulsewire); kind numbers provisional until NIP review.
    27117: t('approveKindGatedDeposit'),
    30808: t('approveKindGatedContent'),
  }

  // Substitutions carry pre-escaped markup for the origin; the message
  // templates themselves ship with the extension and are trusted.
  const boldOrigin = '<strong>' + escapeHtml(details.origin) + '</strong>'

  if (details.method === 'signEvent' && details.event) {
    const kind = details.event.kind
    const kindLabel = kindNames[kind] || t('kindN', [String(kind)])
    title.textContent = t('signTitle', [kindLabel])
    originText.innerHTML = t('wantsToSignEvent', [boldOrigin, escapeHtml(kindLabel)])
    eventJson.textContent = JSON.stringify(details.event, null, 2)
    eventDetails.style.display = ''
    requestHint.textContent = t('approvalSignedEventHint')
    requestHint.style.display = ''
    if (!kindNames[kind]) requestWarning.style.display = ''
    if ([1, 7, 30023].includes(kind)) {
      // Event text is untrusted: show it literally, without loading embeds,
      // link previews or remote media while the user is deciding.
      requestContent.textContent = details.event.content || t('approvalEmptyContent')
      requestPreview.style.display = ''
    }
    if (kind === 0 && details.event.content) {
      renderProfileFields(details.event.content)
    }
  } else if (details.method === 'getPublicKey') {
    title.textContent = t('shareIdentityTitle')
    originText.innerHTML = t('wantsPublicKey', [boldOrigin])
  } else if (details.method === 'getRelays') {
    title.textContent = t('shareRelaysTitle')
    originText.innerHTML = t('wantsRelayList', [boldOrigin])
  } else if (details.method === 'nip04.encrypt') {
    title.textContent = t('encryptTitle')
    originText.innerHTML = t('wantsEncryptLegacy', [boldOrigin])
  } else if (details.method === 'nip04.decrypt') {
    title.textContent = t('decryptTitle')
    originText.innerHTML = t('wantsDecryptLegacy', [boldOrigin])
    requestHint.textContent = t('approvalDecryptionHint')
    requestHint.style.display = ''
  } else if (details.method === 'nip44.encrypt') {
    title.textContent = t('encryptTitle')
    originText.innerHTML = t('wantsEncrypt', [boldOrigin])
  } else if (details.method === 'nip44.decrypt') {
    title.textContent = t('decryptTitle')
    originText.innerHTML = t('wantsDecrypt', [boldOrigin])
    requestHint.textContent = t('approvalDecryptionHint')
    requestHint.style.display = ''
  } else if (details.method === 'heartwood_list_identities') {
    title.textContent = t('listIdentitiesTitle')
    originText.innerHTML = t('wantsListIdentities', [boldOrigin])
  } else if (details.method === 'heartwood_derive' || details.method === 'heartwood_derive_persona') {
    title.textContent = t('deriveIdentityTitle')
    originText.innerHTML = t('wantsDeriveIdentity', [boldOrigin])
  } else if (details.method === 'heartwood_switch') {
    title.textContent = t('switchIdentityTitle')
    originText.innerHTML = t('wantsSwitchIdentity', [boldOrigin])
  } else {
    title.textContent = t('approveRequestTitle')
    originText.innerHTML = t('wantsCallMethod', [boldOrigin, '<code>' + escapeHtml(details.method) + '</code>'])
  }

  // Persona info
  personaName.textContent = details.personaName && details.personaName !== 'default'
    ? details.personaName : t('approvalConnectedIdentity')
  let publicKey = details.pubkey || ''
  try { publicKey = npubEncode(publicKey) } catch { /* show the supplied key literally */ }
  personaNpub.textContent = truncate(publicKey)
  personaFullKey.textContent = publicKey
  trustSection.style.display = details.canTrustSite ? '' : 'none'
  if (Number.isFinite(details.expiresAt)) {
    expiresAt = details.expiresAt
    updateReviewTime()
    if (!reviewExpired()) expiryTimer = setInterval(updateReviewTime, 1000)
  }

  // On short/zoomed screens keep focus on the visible request heading.
  // Enter on that heading still denies; Tab visits the request details.
  denyBtn.focus({ preventScroll: true })
  const bounds = denyBtn.getBoundingClientRect()
  if (bounds.top < 0 || bounds.bottom > window.innerHeight) title.focus({ preventScroll: true })
}

allowBtn.addEventListener('click', () => sendDecision('allow-once'))
trustBtn.addEventListener('click', () => sendDecision('allow-site'))
denyBtn.addEventListener('click', () => sendDecision('deny'))

// Keyboard: Escape = deny
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sendDecision('deny')
  if (e.key === 'Enter' && document.activeElement === title) {
    e.preventDefault()
    sendDecision('deny')
  }
})

init()
