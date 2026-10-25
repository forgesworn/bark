import { describe, it, expect } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { validateProvisionRequest, provisionArgs, validateProvisionResponse, isProvisionOrigin } from '../src/rendezvous-provision.js'
const key = n => getPublicKey(new Uint8Array(32).fill(n))
const now = Math.floor(Date.now() / 1000)
const request = { v: 1, expectedPersona: key(1), targetDevice: key(2), index: 0xffffffff, nonce: 'AAECAwQFBgcICQoLDA0ODw', expiresAt: now + 300 }
const envelope = { v: 1, p: request.expectedPersona, d: request.targetDevice, rz: key(3), u: 'rendezvous', i: request.index, n: request.nonce, e: request.expiresAt, c: 'A'.repeat(132) }

describe('bounded rendezvous bridge', () => {
  it('freezes a copied exact request and emits numeric Heartwood arguments', () => {
    const value = validateProvisionRequest(request, now)
    expect(value).not.toBe(request)
    expect(Object.isFrozen(value)).toBe(true)
    expect(provisionArgs(value)).toEqual([request.targetDevice, 0xffffffff, request.nonce, request.expiresAt])
  })
  it.each([
    null, [], {}, { ...request, v: '1' }, { ...request, extra: 1 },
    { ...request, expectedPersona: request.expectedPersona.toUpperCase() },
    { ...request, targetDevice: 'ff'.repeat(32) }, { ...request, targetDevice: '00'.repeat(32) },
    { ...request, index: '0' }, { ...request, index: -1 }, { ...request, index: 1.5 }, { ...request, index: 0x100000000 },
    { ...request, nonce: 'AAECAwQFBgcICQoLDA0ODx' }, { ...request, nonce: request.nonce + '==' },
    { ...request, expiresAt: now }, { ...request, expiresAt: now + 601 }, { ...request, expiresAt: Infinity },
  ])('rejects invalid parameters before dispatch: %#', value => {
    expect(() => validateProvisionRequest(value, now)).toThrow('Invalid rendezvous provisioning request')
  })
  it('returns exact encrypted text, including original spacing and ordering', () => {
    const text = JSON.stringify(envelope, null, 1)
    expect(validateProvisionResponse(text, request, now)).toBe(text)
  })
  it.each([
    { ...envelope, p: key(4) }, { ...envelope, d: key(4) }, { ...envelope, rz: 'ff'.repeat(32) },
    { ...envelope, i: 0 }, { ...envelope, e: request.expiresAt + 1 }, { ...envelope, n: 'A'.repeat(22) },
    { ...envelope, k: 'plaintext-is-forbidden' }, { ...envelope, c: '' }, { ...envelope, c: '{}' },
  ])('rejects unbound or non-encrypted replies: %#', value => {
    expect(() => validateProvisionResponse(JSON.stringify(value), request, now)).toThrow('Invalid rendezvous provisioning response')
  })
  it('bounds malformed, oversized and expired replies', () => {
    for (const text of [null, '{}', 'a'.repeat(8193)]) expect(() => validateProvisionResponse(text, request, now)).toThrow()
    expect(() => validateProvisionResponse(JSON.stringify(envelope), request, request.expiresAt)).toThrow()
  })
  it('admits HTTPS and exact loopback origins only', () => {
    for (const value of ['https://app.example', 'http://localhost:5173', 'http://127.0.0.1:1', 'http://[::1]:5']) expect(isProvisionOrigin(value)).toBe(true)
    for (const value of ['http://app.example', 'null', 'file:///', 'https://app.example/path', 'https://user@app.example', 'http://localhost.evil', 'http://127.0.0.2']) expect(isProvisionOrigin(value)).toBe(false)
  })
})
