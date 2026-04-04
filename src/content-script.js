const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

let isStale = false

/** Maximum retries when the service worker is asleep (not invalidated). */
const MAX_SW_RETRIES = 3

/** Delay between retries (ms) — gives the service worker time to restart. */
const SW_RETRY_DELAY_MS = 500

/**
 * Send a message to the background service worker, retrying if the worker is
 * asleep. Chrome MV3 service workers are killed after 30s of inactivity;
 * calling chrome.runtime.sendMessage wakes them, but the first attempt may
 * fail with "Receiving end does not exist" before the listener is registered.
 * A short retry loop handles this without marking the extension as stale.
 */
async function sendToBackground(payload) {
  let lastErr
  for (let attempt = 0; attempt < MAX_SW_RETRIES; attempt++) {
    try {
      return await chrome.runtime.sendMessage(payload)
    } catch (err) {
      lastErr = err
      const msg = String(err?.message || '')

      // "Extension context invalidated" means a genuine update/reload — no
      // amount of retrying will help. Mark stale immediately.
      if (msg.includes('context invalidated')) {
        throw err
      }

      // "Receiving end does not exist" means the service worker is waking up.
      // Wait briefly and retry.
      if (msg.includes('does not exist') && attempt < MAX_SW_RETRIES - 1) {
        await new Promise(r => setTimeout(r, SW_RETRY_DELAY_MS))
        continue
      }

      throw err
    }
  }
  throw lastErr
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

  if (isStale) {
    window.postMessage(
      { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' },
      window.location.origin,
    )
    return
  }

  try {
    const result = await sendToBackground({ type: 'bark-request', method, params })
    if (result && result.error) {
      window.postMessage({ type: 'bark-response', id, error: result.error }, window.location.origin)
    } else {
      window.postMessage({ type: 'bark-response', id, result }, window.location.origin)
    }
  } catch (err) {
    // "Extension context invalidated" means the extension was updated or
    // reloaded. The page must be refreshed — mark as permanently stale.
    const msg = String(err?.message || '')
    if (msg.includes('context invalidated')) {
      isStale = true
      window.postMessage(
        { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' },
        window.location.origin,
      )
    } else {
      // Transient failure (retries exhausted, network issue, etc.)
      window.postMessage(
        { type: 'bark-response', id, error: 'Request failed — service worker unavailable.' },
        window.location.origin,
      )
    }
  }
})
