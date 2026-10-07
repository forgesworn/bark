import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { fromBunker, stored } = vi.hoisted(() => ({
  fromBunker: vi.fn(),
  stored: { instances: [{ id: 'test', name: 'bunker',
    bunkerUri: 'bunker://' + 'ab'.repeat(32) + '?relay=wss://relay.example',
    clientSecret: '12'.repeat(32), connectOrigin: 'https://app.example',
    signingVerifiedAt: 1 }], activeInstanceId: 'test' },
}))
vi.mock('nostr-tools/nip46', async (original) => ({
  ...await original(), BunkerSigner: { fromBunker },
}))
vi.stubGlobal('chrome', { storage: { local: {
  get: vi.fn(async () => structuredClone(stored)), set: vi.fn(async () => {}),
} } })
const { ensureConnected, resetConnection, connectionState } = await import('../src/background.js')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeSigner(handshake) {
  return {
    close: vi.fn(),
    pool: { relays: new Map(), ensureRelay: vi.fn(async () => {}) },
    sendRequest: vi.fn(async (method) => method === 'connect' ? handshake.promise : '[]'),
  }
}
beforeEach(async () => {
  vi.useFakeTimers()
  await resetConnection()
  fromBunker.mockReset()
})
afterEach(async () => { await resetConnection(); vi.useRealTimers() })

describe('connection ownership', () => {
  it.each([false, true])('joins an in-flight handshake with pool alive=%s instead of closing or returning its unfinished signer', async (alive) => {
    const handshake = deferred(), candidate = fakeSigner(handshake)
    if (alive) candidate.pool.relays.set('wss://relay.example', { connected: true })
    fromBunker.mockReturnValue(candidate)
    const first = ensureConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.sendRequest).toHaveBeenCalledWith('connect', expect.any(Array))
    let secondSettled = false
    const second = ensureConnected().then(value => { secondSettled = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).not.toHaveBeenCalled()
    expect(secondSettled).toBe(false)
    handshake.resolve('ack')
    expect(await first).toBe(candidate)
    expect(await second).toBe(candidate)
    expect(fromBunker).toHaveBeenCalledOnce()
    // The completed handshake no longer owns connectPromise, but its signer
    // must still deliver later auth_url approval prompts until it is replaced.
    const { onauth } = fromBunker.mock.calls[0][2]
    onauth('https://signer.example/approve')
    expect(connectionState.status).toBe('awaiting-approval')
    await resetConnection()
    onauth('https://signer.example/stale')
    expect(connectionState.status).toBe('disconnected')
  })
  it('does not let a reset handshake clear or return a replacement connection', async () => {
    const oldHandshake = deferred(), newHandshake = deferred()
    const oldSigner = fakeSigner(oldHandshake), newSigner = fakeSigner(newHandshake)
    fromBunker.mockReturnValueOnce(oldSigner).mockReturnValueOnce(newSigner)
    const oldAttempt = ensureConnected()
    const rejected = expect(oldAttempt).rejects.toThrow(/changed|cancelled/i)
    await vi.advanceTimersByTimeAsync(0)
    await resetConnection()
    const nextAttempt = ensureConnected()
    await vi.advanceTimersByTimeAsync(0)
    oldHandshake.resolve('ack')
    await rejected
    const joined = ensureConnected()
    newHandshake.resolve('ack')
    expect(await nextAttempt).toBe(newSigner)
    expect(await joined).toBe(newSigner)
    expect(newSigner.close).not.toHaveBeenCalled()
    expect(connectionState.status).toBe('connected')
    expect(fromBunker).toHaveBeenCalledTimes(2)
  })
})
