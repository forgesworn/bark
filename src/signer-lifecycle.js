// Bark owns each BunkerSigner's pool. nostr-tools close() only unsubscribes:
// it neither closes the pool's sockets nor settles outstanding RPC listeners.
// Keep this adapter covered against the real dependency, not just mocks.
const disposed = new WeakSet()

export function disposeSigner(bunker) {
  if (!bunker || disposed.has(bunker)) return
  disposed.add(bunker)
  try { Promise.resolve(bunker.close()).catch(() => {}) } catch { /* already closed */ }
  try { bunker.pool?.destroy() } catch { /* already closed */ }
  for (const [id, listener] of Object.entries(bunker.listeners || {})) {
    delete bunker.listeners[id]
    listener.reject(new Error('Signer connection changed; retry the request.'))
  }
  for (const id of Object.keys(bunker.waitingForAuth || {})) delete bunker.waitingForAuth[id]
}


const tracked = new WeakSet()

// nostr-tools keeps waitingForAuth entries even after a normal reply. Remove
// both per-request entries once settled. The serial/idPrefix contract is
// exercised by the real-library test so dependency changes fail visibly.
export function trackSignerRequests(bunker) {
  if (!bunker || tracked.has(bunker) || !Number.isInteger(bunker.serial)) return
  tracked.add(bunker)
  const send = bunker.sendRequest.bind(bunker)
  bunker.sendRequest = (method, params) => {
    const before = bunker.serial
    const pending = send(method, params)
    const id = Number.isInteger(bunker.serial) && bunker.serial !== before
      ? `${bunker.idPrefix}-${bunker.serial}` : null
    return Promise.resolve(pending).finally(() => {
      if (id === null) return
      delete bunker.listeners?.[id]
      delete bunker.waitingForAuth?.[id]
    })
  }
}
