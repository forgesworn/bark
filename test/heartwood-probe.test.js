import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// finaliseConnection() writes detected Heartwood state via chrome.storage.local,
// so the fake chrome global must exist before background.js is first imported
// (its module-level `const chrome = globalThis.browser || globalThis.chrome`
// only evaluates once).
const storageSet = vi.fn().mockResolvedValue(undefined)
vi.stubGlobal('chrome', {
  storage: { local: { set: storageSet } },
})

const { finaliseConnection, __setSignerForTest, connectionState } = await import('../src/background.js')

const BUNKER_URI = 'bunker://' + 'a'.repeat(64) + '?relay=wss://relay.example'

function makeActive() {
  // signingVerifiedAt truthy skips scheduleSignerPrime's setTimeout, which
  // would otherwise leave a dangling fake timer in these tests.
  return { name: 'bunker', signingVerifiedAt: Date.now() }
}

/** A signer whose sendRequest() never settles — used to force the internal
 * probe timeout race to win. */
function neverResolves() {
  return new Promise(() => {})
}

/** A signer whose sendRequest() resolves after `delayMs` (driven by fake timers). */
function resolvesAfter(delayMs, value = '[]') {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs))
}

/** A signer whose sendRequest() rejects immediately with the given message. */
function rejectsWith(message) {
  return Promise.reject(new Error(message))
}

beforeEach(() => {
  vi.useFakeTimers()
  storageSet.mockClear()
  connectionState.isHeartwood = false
  connectionState.heartwoodProbePending = false
  connectionState.status = 'connected'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Heartwood probe timeout handling', () => {
  it('treats a timeout as awaiting approval, then enables Heartwood on late success', async () => {
    const calls = [neverResolves(), resolvesAfter(20_000, '[]')]
    let callIndex = 0
    const sendRequest = vi.fn(() => calls[callIndex++])
    __setSignerForTest({ sendRequest })

    const active = makeActive()
    const p = finaliseConnection(active, [active], BUNKER_URI, [])
    await vi.advanceTimersByTimeAsync(5_000) // initial HEARTWOOD_PROBE_TIMEOUT_MS
    await p

    // Standard NIP-07 connect flow is not blocked by the pending probe.
    expect(connectionState.isHeartwood).toBe(false)
    expect(connectionState.heartwoodProbePending).toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(2)

    // Late success within the extended (45s) budget enables Heartwood mode.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(connectionState.isHeartwood).toBe(true)
    expect(connectionState.heartwoodProbePending).toBe(false)
    expect(active.isHeartwood).toBe(true)
  })

  it('falls back to not-Heartwood on a final timeout, but allows a later retry', async () => {
    const sendRequest = vi.fn(() => neverResolves())
    __setSignerForTest({ sendRequest })

    const active = makeActive()
    const p = finaliseConnection(active, [active], BUNKER_URI, [])
    await vi.advanceTimersByTimeAsync(5_000) // initial probe times out
    await p

    expect(connectionState.heartwoodProbePending).toBe(true)

    await vi.advanceTimersByTimeAsync(45_000) // extended probe also times out
    expect(connectionState.isHeartwood).toBe(false)
    expect(connectionState.heartwoodProbePending).toBe(false)
    // The negative result is not persisted — a later retry probes again
    // rather than being blocked by a cached verdict.
    expect(storageSet).not.toHaveBeenCalledWith({ isHeartwood: false })

    // Retry: a fresh connect (e.g. next popup open or reconnect) probes again.
    const retrySendRequest = vi.fn().mockResolvedValue('[]')
    __setSignerForTest({ sendRequest: retrySendRequest })
    const retryActive = makeActive()
    await finaliseConnection(retryActive, [retryActive], BUNKER_URI, [])
    expect(connectionState.isHeartwood).toBe(true)
    expect(retryActive.isHeartwood).toBe(true)
  })

  it('treats an explicit error response as not-Heartwood immediately, without waiting', async () => {
    const sendRequest = vi.fn(() => rejectsWith('unknown method: heartwood_list_identities'))
    __setSignerForTest({ sendRequest })

    const active = makeActive()
    await finaliseConnection(active, [active], BUNKER_URI, [])

    expect(connectionState.isHeartwood).toBe(false)
    expect(connectionState.heartwoodProbePending).toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1) // no extended background probe

    // Advancing time confirms nothing further happens in the background.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connectionState.isHeartwood).toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
