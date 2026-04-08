;(function () {
  if (window.nostr) return

  const pending = new Map()
  let idCounter = 0

  /** Timeout for NIP-07 requests (ms). Allows for ESP32 button approval (~30s)
   *  plus relay round-trip and service worker wake time. */
  const REQUEST_TIMEOUT_MS = 60_000

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idCounter
      const timeoutId = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('Bark request timed out.'))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timeoutId })
      console.log('[bark:provider] →', method, 'id=' + id)
      window.postMessage({ type: 'bark-request', id, method, params }, window.location.origin)
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (event.data?.type !== 'bark-response') return
    const { id, result, error } = event.data
    console.log('[bark:provider] ←', 'id=' + id, error ? 'error=' + error : 'result=', result)
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timeoutId)
    if (error) {
      if (error === 'Bark was updated. Please refresh the page.') {
        showStaleBanner()
        return // don't reject — user needs to refresh, hanging promise is fine
      }
      p.reject(new Error(error))
    } else {
      p.resolve(result)
    }
  })

  let bannerShown = false
  function showStaleBanner() {
    if (bannerShown) return
    bannerShown = true

    const banner = document.createElement('div')
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#e0e0e0;padding:10px 16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #339933;'
    banner.textContent = 'Bark was updated \u2014 please refresh this page.'

    const close = document.createElement('button')
    close.textContent = '\u00D7'
    close.style.cssText = 'background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px;margin-left:12px;'
    close.addEventListener('click', () => banner.remove())

    banner.appendChild(close)
    document.body.appendChild(banner)
  }

  window.nostr = {
    async getPublicKey() { return call('getPublicKey') },
    async signEvent(event) { return call('signEvent', event) },
    nip44: {
      async encrypt(pubkey, plaintext) { return call('nip44.encrypt', { pubkey, plaintext }) },
      async decrypt(pubkey, ciphertext) { return call('nip44.decrypt', { pubkey, ciphertext }) },
    },
    heartwood: {
      async lsagSign(params) { return call('heartwood_lsag_sign', params) },
    },
  }
})()
