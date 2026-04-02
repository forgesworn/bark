const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

let isStale = false

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
    const result = await chrome.runtime.sendMessage({ type: 'bark-request', method, params })
    window.postMessage({ type: 'bark-response', id, result }, window.location.origin)
  } catch (err) {
    // "Extension context invalidated" means the service worker was killed
    // after an extension update/reload. The page must be refreshed.
    const msg = String(err?.message || '')
    const stale = msg.includes('context invalidated') || msg.includes('does not exist')
    if (stale) isStale = true
    window.postMessage(
      { type: 'bark-response', id, error: stale ? 'Bark was updated. Please refresh the page.' : 'Request failed' },
      window.location.origin,
    )
  }
})
