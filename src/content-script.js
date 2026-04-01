const script = document.createElement('script')
script.src = chrome.runtime.getURL('provider.js')
script.onload = () => script.remove()
;(document.head || document.documentElement).appendChild(script)

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.type !== 'bark-request') return
  const { id, method, params } = event.data
  try {
    const result = await chrome.runtime.sendMessage({ type: 'bark-request', method, params })
    window.postMessage({ type: 'bark-response', id, result }, '*')
  } catch (err) {
    window.postMessage({ type: 'bark-response', id, error: err.message }, '*')
  }
})
