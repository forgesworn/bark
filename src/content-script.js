const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

let isStale = false

/**
 * Send a message to the background service worker, retrying once if the worker
 * is asleep. MV3 service workers die after ~30s of inactivity; the first
 * sendMessage wakes them but may fail before the listener is registered.
 */
async function sendToBackground(payload) {
  try {
    const result = await chrome.runtime.sendMessage(payload)
    console.log('[bark:content] ← bg responded', payload.method, result)
    return result
  } catch (err) {
    const msg = String(err?.message || '')
    console.log('[bark:content] ✗ sendMessage failed:', msg)
    // Genuine invalidation — extension was updated/reloaded. No retry.
    if (msg.includes('context invalidated')) throw err
    // Service worker waking up — retry once after a short delay.
    if (msg.includes('does not exist')) {
      console.log('[bark:content] retrying after 500ms (service worker waking)')
      await new Promise(r => setTimeout(r, 500))
      return await chrome.runtime.sendMessage(payload)
    }
    throw err
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
    const result = await sendToBackground({ type: 'bark-request', method, params })
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
