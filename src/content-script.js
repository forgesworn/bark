const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

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

  try {
    const result = await chrome.runtime.sendMessage({ type: 'bark-request', method, params })
    window.postMessage({ type: 'bark-response', id, result }, window.location.origin)
  } catch (err) {
    window.postMessage(
      { type: 'bark-response', id, error: 'Request failed' },
      window.location.origin,
    )
  }
})
