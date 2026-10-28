import { describe, it, expect } from 'vitest'
import { prepareCryptoApproval, CRYPTO_PREVIEW_BYTES } from '../src/crypto-approval.js'
import { isSenderAllowedForMessage } from '../src/background.js'
const peer = 'ab'.repeat(32)

describe('trusted crypto approval DTO', () => {
  it.each(['nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt', 'nip44.decrypt'])('binds %s to its exact peer and method-specific input', method => {
    const field = method.endsWith('.encrypt') ? 'plaintext' : 'ciphertext'
    const params = { pubkey: peer, [field]: '0123456789abcdef'.repeat(4), unusedSecret: 'never forward this' }
    const approval = prepareCryptoApproval(method, params)
    expect(approval.params).toEqual({ pubkey: peer, [field]: params[field] })
    expect(approval.preview).toEqual({ method, peerPubkey: peer, inputType: field,
      inputPreview: params[field], inputBytes: 64, previewBytes: 64, complete: true })
    params.pubkey = 'cd'.repeat(32); params[field] = 'changed after review'
    expect(approval.params.pubkey).toBe(peer)
    expect(approval.params[field]).toBe(approval.preview.inputPreview)
    expect(() => { approval.params[field] = 'changed' }).toThrow()
    expect(JSON.stringify(approval)).not.toContain('never forward this')
  })

  it('does not inspect or expose params for another method', () => {
    const params = new Proxy({}, { get() { throw Error('must not inspect') } })
    for (const method of ['getPublicKey', 'signEvent', 'heartwood_derive', 'nip44.other', 'nip44.encrypt.extra']) {
      expect(prepareCryptoApproval(method, params)).toBeNull()
    }
  })

  it('rejects malformed peers and the wrong payload field without echoing inputs', () => {
    for (const pubkey of ['', 'a'.repeat(63), 'AB'.repeat(32), '<img src=x>']) {
      expect(() => prepareCryptoApproval('nip44.encrypt', { pubkey, plaintext: 'secret' })).toThrow('Invalid pubkey')
    }
    for (const params of [null, { pubkey: null, plaintext: 'secret' }, { pubkey: peer, ciphertext: 'secret' }, { pubkey: peer, plaintext: 1 }]) {
      expect(() => prepareCryptoApproval('nip44.encrypt', params)).toThrow('requires pubkey and plaintext')
    }
    expect(() => prepareCryptoApproval('nip44.decrypt', { pubkey: peer, plaintext: 'secret' })).toThrow('requires pubkey and ciphertext')
  })

  it('bounds the DTO by UTF-8 bytes without cutting a Unicode character or claiming completeness', () => {
    const text = 'a'.repeat(CRYPTO_PREVIEW_BYTES - 1) + '💚z'
    const result = prepareCryptoApproval('nip44.encrypt', { pubkey: peer, plaintext: text })
    expect(result.preview).toMatchObject({ complete: false, previewBytes: 4095, inputBytes: 4100, inputPreview: 'a'.repeat(4095) })
    expect(result.params.plaintext).toBe(text)
    expect(JSON.stringify(result.preview)).not.toContain('💚z')
    for (const text of ['', '漢字💚', 'e\u0301', '\ud800', '<script>alert(1)</script>']) {
      const p = prepareCryptoApproval('nip44.encrypt', { pubkey: peer, plaintext: text }).preview
      expect(p.inputPreview).toBe(text)
      expect(p.inputBytes).toBe(new TextEncoder().encode(text).length)
      expect(p.complete).toBe(true)
    }
  })

  it('keeps the approval query inaccessible to content scripts and foreign extension origins', () => {
    const base = 'chrome-extension://bark-test/'
    for (const origin of ['https://example.com', 'chrome-extension://other-extension']) {
      expect(isSenderAllowedForMessage({ tab: { id: 1 }, origin }, 'bark-approval-query', base)).toBe(false)
    }
    expect(isSenderAllowedForMessage({ tab: { id: 1 }, origin: 'chrome-extension://bark-test' }, 'bark-approval-query', base)).toBe(true)
  })
})
