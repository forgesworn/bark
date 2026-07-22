import { isOriginExposed } from './policy.js'
import { t } from './i18n.js'

const extensionApi = globalThis.chrome || globalThis.browser

function runtimeGetURL(path) {
  return extensionApi.runtime.getURL(path)
}

function storageGet(keys) {
  if (globalThis.chrome?.storage?.local?.get) {
    return new Promise((resolve) => {
      globalThis.chrome.storage.local.get(keys, (items) => resolve(items || {}))
    })
  }
  if (globalThis.browser?.storage?.local?.get) return globalThis.browser.storage.local.get(keys)
  return Promise.resolve({})
}

function runtimeSendMessage(payload) {
  if (globalThis.chrome?.runtime?.sendMessage) {
    return new Promise((resolve, reject) => {
      globalThis.chrome.runtime.sendMessage(payload, (result) => {
        const err = globalThis.chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(result)
      })
    })
  }
  if (globalThis.browser?.runtime?.sendMessage) return globalThis.browser.runtime.sendMessage(payload)
  return Promise.reject(new Error('Extension runtime unavailable.'))
}

// ---------------------------------------------------------------------------
// In-page approval attention
// ---------------------------------------------------------------------------

const APPROVAL_NOTICE_HOST_ID = 'bark-approval-notice-host'
const pendingApprovalNotices = new Set()
let approvalNoticeHost = null

function removeApprovalNoticeIfIdle() {
  if (pendingApprovalNotices.size > 0) return
  approvalNoticeHost?.remove()
  approvalNoticeHost = null
}

function clearApprovalNotice(requestId) {
  pendingApprovalNotices.delete(requestId)
  removeApprovalNoticeIfIdle()
}

function showApprovalNotice(requestId) {
  pendingApprovalNotices.add(requestId)
  if (approvalNoticeHost?.isConnected) return

  const host = document.createElement('div')
  host.id = APPROVAL_NOTICE_HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      right: 18px !important;
      bottom: 18px !important;
      z-index: 2147483647 !important;
      display: block !important;
      max-width: min(380px, calc(100vw - 36px)) !important;
      color-scheme: dark !important;
    }
    .notice {
      box-sizing: border-box;
      width: 360px;
      max-width: 100%;
      padding: 16px;
      border: 2px solid #55d86a;
      border-radius: 10px;
      background: #111820;
      color: #f4f7f8;
      box-shadow: 0 14px 42px rgba(0, 0, 0, .48);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.4;
    }
    .brand {
      margin: 0 0 4px;
      color: #55d86a;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .14em;
    }
    h2 {
      margin: 0 0 6px;
      color: #fff;
      font-size: 17px;
      font-weight: 750;
    }
    p {
      margin: 0 0 12px;
      color: #c8d1d5;
      font-size: 14px;
    }
    button {
      appearance: none;
      box-sizing: border-box;
      border: 0;
      border-radius: 7px;
      background: #55d86a;
      color: #07120a;
      cursor: pointer;
      padding: 9px 13px;
      font: 750 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button:hover { background: #72e484; }
    button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
    .status {
      min-height: 0;
      margin: 8px 0 0;
      color: #ffcf70;
      font-size: 12px;
    }
    .status:empty { display: none; }
  `

  const notice = document.createElement('section')
  notice.className = 'notice'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'assertive')

  const brand = document.createElement('div')
  brand.className = 'brand'
  brand.textContent = 'BARK'

  const title = document.createElement('h2')
  title.textContent = t('approvalNoticeTitle')

  const body = document.createElement('p')
  body.textContent = t('approvalNoticeBody')

  const review = document.createElement('button')
  review.type = 'button'
  review.textContent = t('approvalNoticeReview')

  const status = document.createElement('p')
  status.className = 'status'

  review.addEventListener('click', async () => {
    review.disabled = true
    status.textContent = ''
    try {
      const result = await runtimeSendMessage({ type: 'bark-focus-approval' })
      if (!result?.ok) status.textContent = t('approvalNoticeFallback')
    } catch {
      status.textContent = t('approvalNoticeFallback')
    } finally {
      review.disabled = false
    }
  })

  notice.append(brand, title, body, review, status)
  shadow.append(style, notice)
  approvalNoticeHost = host
  ;(document.body || document.documentElement).appendChild(host)
}

if (extensionApi.runtime?.onMessage) {
  extensionApi.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'bark-approval-pending') return
    if (!Number.isInteger(message.requestId) || message.requestId <= 0) return
    showApprovalNotice(message.requestId)
  })
}

// Chromium and Firefox (128+) inject provider.js declaratively via a
// MAIN-world content script in the manifest, which removes the race where
// page scripts run before window.nostr exists. Safari builds fall back to
// script-tag injection (the define is set per build target by esbuild).
const INJECT_PROVIDER = typeof __BARK_INJECT_PROVIDER__ === 'undefined' || __BARK_INJECT_PROVIDER__

// Privacy mode: when enabled, window.nostr is exposed only to origins the
// user has a site rule for. The verdict is computed here from storage (no
// service worker wake-up) and travels to the MAIN-world provider via
// postMessage. Dropping requests below is the real enforcement point —
// deleting window.nostr alone would not stop a page that synthesises
// bark-request messages by hand. On a storage failure we fail open: privacy
// mode off is the default state, and a transient error must not kill NIP-07.
let siteHidden = false

async function applyExposure() {
  let exposed = true
  try {
    const { privacy, policies } = await storageGet(['privacy', 'policies'])
    exposed = isOriginExposed(policies, Boolean(privacy?.enabled), window.location.origin)
  } catch { /* fail open */ }
  siteHidden = !exposed
  if (INJECT_PROVIDER) {
    if (!exposed) return
    const script = document.createElement('script')
    script.src = runtimeGetURL('provider.js')
    script.onload = () => script.remove()
    ;(document.head || document.documentElement).appendChild(script)
  } else if (!exposed) {
    window.postMessage({ type: 'bark-expose', exposed: false }, window.location.origin)
  }
}
applyExposure()

const DEBUG = false
function debug(...args) {
  if (DEBUG) console.debug(...args)
}

let isStale = false

/**
 * Serialise messages to the background service worker. MV3 workers die after
 * ~30s of inactivity; the first sendMessage wakes them but may fail or resolve
 * with undefined before the onMessage listener is registered. A queue ensures
 * a second message isn't dispatched while the first is still retrying through
 * the wake-up window.
 */
let sendQueue = Promise.resolve()

function enqueueSend(payload) {
  const p = sendQueue.then(() => sendToBackground(payload))
  // Swallow rejections so the queue itself never stalls.
  sendQueue = p.catch(() => {})
  return p
}

async function sendToBackground(payload) {
  const MAX_RETRIES = 8
  const RETRY_DELAY = 750

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await runtimeSendMessage(payload)

      // undefined means no listener handled the message — worker is alive
      // but not yet initialised. Retry after a short delay.
      if (result === undefined && attempt < MAX_RETRIES - 1) {
        debug('[bark:content] ✗ undefined response for', payload.method, '— retrying')
        await new Promise(r => setTimeout(r, RETRY_DELAY))
        continue
      }

      debug('[bark:content] ← bg responded', payload.method, result)
      return result
    } catch (err) {
      const msg = String(err?.message || '')
      debug('[bark:content] ✗ sendMessage failed:', msg)

      // Genuine invalidation — extension was updated/reloaded. No retry.
      if (msg.includes('context invalidated')) throw err

      // Service worker waking up — retry after a short delay. "message port
      // closed" is Chrome's wording when the worker is woken by the message
      // but torn down before it responds — the first call after idle.
      const isWakeupError = msg.includes('does not exist') ||
        msg.includes('Receiving end does not exist') ||
        msg.includes('Could not establish connection') ||
        msg.includes('message port closed')
      if (isWakeupError && attempt < MAX_RETRIES - 1) {
        debug('[bark:content] retrying after', RETRY_DELAY, 'ms (service worker waking)')
        await new Promise(r => setTimeout(r, RETRY_DELAY))
        continue
      }

      throw err
    }
  }
}

window.addEventListener('message', async (event) => {
  // Only accept messages from the same window, not from iframes or other origins.
  if (event.source !== window) return
  if (event.origin !== window.location.origin) return
  if (event.data?.type !== 'bark-request') return

  // Hidden origins get silence, not an error — an error would itself be a
  // fingerprint that Bark is installed.
  if (siteHidden) return

  const { id, method, params } = event.data

  // Validate id is a positive integer to prevent spoofed/replayed responses.
  if (typeof id !== 'number' || id <= 0 || !Number.isInteger(id)) return

  // Validate method is a non-empty string.
  if (typeof method !== 'string' || method.length === 0) return

  debug('[bark:content] → bg', method, 'id=' + id)

  if (isStale) {
    window.postMessage(
      { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' },
      window.location.origin,
    )
    return
  }

  try {
    const result = await enqueueSend({ type: 'bark-request', method, params, pageRequestId: id })
    // Background sends errors as {error: 'msg'} via sendResponse — unwrap them.
    if (result && result.error) {
      window.postMessage({ type: 'bark-response', id, error: result.error }, window.location.origin)
    } else {
      window.postMessage({ type: 'bark-response', id, result }, window.location.origin)
    }
  } catch (err) {
    const msg = String(err?.message || '')
    // Only "context invalidated" is genuinely permanent — the extension was
    // reloaded/updated and this content script is orphaned.
    if (msg.includes('context invalidated')) {
      isStale = true
      window.postMessage(
        { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' },
        window.location.origin,
      )
    } else {
      window.postMessage(
        { type: 'bark-response', id, error: 'Service worker unavailable. Try again.' },
        window.location.origin,
      )
    }
  } finally {
    clearApprovalNotice(id)
  }
})
