const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

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
  const MAX_RETRIES = 3
  const RETRY_DELAY = 500

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await chrome.runtime.sendMessage(payload)

      // undefined means no listener handled the message — worker is alive
      // but not yet initialised. Retry after a short delay.
      if (result === undefined && attempt < MAX_RETRIES - 1) {
        console.log('[bark:content] ✗ undefined response for', payload.method, '— retrying')
        await new Promise(r => setTimeout(r, RETRY_DELAY))
        continue
      }

      console.log('[bark:content] ← bg responded', payload.method, result)
      return result
    } catch (err) {
      const msg = String(err?.message || '')
      console.log('[bark:content] ✗ sendMessage failed:', msg)

      // Genuine invalidation — extension was updated/reloaded. No retry.
      if (msg.includes('context invalidated')) throw err

      // Service worker waking up — retry after a short delay.
      if (msg.includes('does not exist') && attempt < MAX_RETRIES - 1) {
        console.log('[bark:content] retrying after', RETRY_DELAY, 'ms (service worker waking)')
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

  const { id, method, params } = event.data

  // Validate id is a positive integer to prevent spoofed/replayed responses.
  if (typeof id !== 'number' || id <= 0 || !Number.isInteger(id)) return

  // Validate method is a non-empty string.
  if (typeof method !== 'string' || method.length === 0) return

  console.log('[bark:content] → bg', method, 'id=' + id)

  if (isStale) {
    window.postMessage(
      { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' },
      window.location.origin,
    )
    return
  }

  try {
    const result = await enqueueSend({ type: 'bark-request', method, params })
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
  }
})
