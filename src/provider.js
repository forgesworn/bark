;(function () {
  if (window.nostr) return

  const DEBUG = false
  function debug(...args) {
    if (DEBUG) console.debug(...args)
  }

  const pending = new Map()
  let idCounter = 0

  /** Timeouts for NIP-07 requests (ms). A signEvent can traverse an approval
   *  window (60s), a cold NIP-46 reconnect, and a hardware button press, and
   *  concurrent requests queue behind each other — so it gets the longest
   *  budget. Other methods stay above the approval + bunker request chain. */
  const SIGN_EVENT_TIMEOUT_MS = 180_000
  const REQUEST_TIMEOUT_MS = 120_000

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idCounter
      const timeoutMs = method === 'signEvent' ? SIGN_EVENT_TIMEOUT_MS : REQUEST_TIMEOUT_MS
      const timeoutId = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        const timeoutMessage = method === 'signEvent'
          ? 'Bark signEvent timed out. Open Bark and test signing.'
          : 'Bark request timed out.'
        reject(new Error(timeoutMessage))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timeoutId })
      debug('[bark:provider] →', method, 'id=' + id)
      window.postMessage({ type: 'bark-request', id, method, params }, window.location.origin)
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (event.data?.type !== 'bark-response') return
    const { id, result, error } = event.data
    debug('[bark:provider] ←', 'id=' + id, error ? 'error=' + error : 'result=', result)
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

  const nostrApi = {
    async getPublicKey() { return call('getPublicKey') },
    async getRelays() { return call('getRelays') },
    async signEvent(event) { return call('signEvent', event) },
    nip04: {
      async encrypt(pubkey, plaintext) { return call('nip04.encrypt', { pubkey, plaintext }) },
      async decrypt(pubkey, ciphertext) { return call('nip04.decrypt', { pubkey, ciphertext }) },
    },
    nip44: {
      async encrypt(pubkey, plaintext) { return call('nip44.encrypt', { pubkey, plaintext }) },
      async decrypt(pubkey, ciphertext) { return call('nip44.decrypt', { pubkey, ciphertext }) },
    },
    heartwood: {
      async switch(target) { return call('heartwood_switch', { target }) },
      async listIdentities() { return call('heartwood_list_identities') },
      async derivePersona(name, index = 0) { return call('heartwood_derive_persona', { name, index }) },
    },
  }

  window.nostr = nostrApi

  // Privacy mode: the content script tells us the user has hidden Bark from
  // this origin. Retract window.nostr (only if it is still ours) so the page
  // cannot detect the extension. The content script independently drops any
  // requests from hidden origins, so this is presentation, not enforcement.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (event.data?.type !== 'bark-expose') return
    if (event.data.exposed === false && window.nostr === nostrApi) {
      delete window.nostr
    }
  })
})()
