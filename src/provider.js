;(function () {
  if (window.nostr) return

  const pending = new Map()
  let idCounter = 0

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idCounter
      pending.set(id, { resolve, reject })
      window.postMessage({ type: 'bark-request', id, method, params }, window.location.origin)
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (event.data?.type !== 'bark-response') return
    const { id, result, error } = event.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  })

  window.nostr = {
    async getPublicKey() { return call('getPublicKey') },
    async signEvent(event) { return call('signEvent', event) },
    nip44: {
      async encrypt(pubkey, plaintext) { return call('nip44.encrypt', { pubkey, plaintext }) },
      async decrypt(pubkey, ciphertext) { return call('nip44.decrypt', { pubkey, ciphertext }) },
    },
  }
})()
