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
const { ensureConnected, resetConnection, connectionState, __setSignerForTest, withBunkerRequestTimeout } = await import('../src/background.js')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeSigner(handshake) {
  return {
    close: vi.fn(),
    pool: { relays: new Map(), ensureRelay: vi.fn(async () => {}), destroy: vi.fn() },
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


describe('handshake recovery', () => {
  it('accepts a late first reply after the six-second retry boundary', async () => {
    const firstReply = deferred(), candidate = fakeSigner(firstReply)
    candidate.sendRequest.mockImplementation((method) => {
      if (method !== 'connect') return Promise.resolve('[]')
      return candidate.sendRequest.mock.calls.filter(([m]) => m === 'connect').length === 1
        ? firstReply.promise : new Promise(() => {})
    })
    fromBunker.mockReturnValue(candidate)
    let result
    const connecting = ensureConnected().then(value => { result = value })
    await vi.advanceTimersByTimeAsync(7_000)
    firstReply.resolve('ack')
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe(candidate)
    await connecting
  })

  it('surfaces a signer refusal once without retrying or reconnecting in the background', async () => {
    const candidate = fakeSigner(deferred())
    candidate.sendRequest.mockRejectedValue(new Error('unauthorised'))
    fromBunker.mockReturnValue(candidate)
    const rejected = expect(ensureConnected()).rejects.toThrow('unauthorised')
    await vi.advanceTimersByTimeAsync(0)
    await rejected
    expect(candidate.sendRequest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(fromBunker).toHaveBeenCalledOnce()
  })

  it('releases relay sockets as well as the subscription on reset', async () => {
    const handshake = deferred(), candidate = fakeSigner(handshake)
    fromBunker.mockReturnValue(candidate)
    const connecting = ensureConnected()
    await vi.advanceTimersByTimeAsync(0)
    handshake.resolve('ack')
    await connecting
    await resetConnection()
    expect(candidate.close).toHaveBeenCalled()
    expect(candidate.pool.destroy).toHaveBeenCalledOnce()
  })
})


describe('requests on superseded connections', () => {
  it('does not let an old timeout reset a replacement connection', async () => {
    const oldSigner = fakeSigner(deferred()), newSigner = fakeSigner(deferred())
    __setSignerForTest(oldSigner)
    const rejected = expect(withBunkerRequestTimeout(new Promise(() => {}), 'old request')).rejects.toThrow('timed out')
    await resetConnection()
    __setSignerForTest(newSigner)
    connectionState.status = 'connected'
    await vi.advanceTimersByTimeAsync(45_000)
    await rejected
    expect(newSigner.close).not.toHaveBeenCalled()
    expect(connectionState.status).toBe('connected')
  })

  it('rejects a stale successful response after changing signer', async () => {
    const reply = deferred()
    __setSignerForTest(fakeSigner(deferred()))
    const rejected = expect(withBunkerRequestTimeout(reply.promise, 'old request')).rejects.toThrow('connection changed')
    await resetConnection()
    __setSignerForTest(fakeSigner(deferred()))
    reply.resolve('old identity')
    await rejected
  })

  it('bounds an unanswered handshake and closes its sockets', async () => {
    const candidate = fakeSigner(deferred())
    fromBunker.mockReturnValue(candidate)
    const rejected = expect(ensureConnected()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(candidate.sendRequest).toHaveBeenCalledTimes(5)
    expect(candidate.pool.destroy).toHaveBeenCalledOnce()
    expect(connectionState.status).toBe('disconnected')
  })
})


it('cleans up a failed publication and clears pending signing health without retrying the operation', async () => {
  const candidate = fakeSigner(deferred())
  __setSignerForTest(candidate)
  connectionState.signingStatus = 'pending'
  await expect(withBunkerRequestTimeout(Promise.reject(new AggregateError([])), 'signEvent'))
    .rejects.toBeInstanceOf(AggregateError)
  expect(candidate.pool.destroy).toHaveBeenCalledOnce()
  expect(connectionState.signingStatus).toBe('error')
  expect(connectionState.signingLastError).toContain('configured signer relay')
})
