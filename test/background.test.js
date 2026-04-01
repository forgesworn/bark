import { describe, it, expect } from 'vitest'
import { parseMethod, isValidHexPubkey, isValidBunkerUri, isValidPurpose } from '../src/background.js'

describe('parseMethod', () => {
  it('parses getPublicKey', () => {
    expect(parseMethod('getPublicKey')).toEqual({ type: 'nip07', method: 'getPublicKey' })
  })

  it('parses signEvent', () => {
    expect(parseMethod('signEvent')).toEqual({ type: 'nip07', method: 'signEvent' })
  })

  it('parses nip44.encrypt', () => {
    expect(parseMethod('nip44.encrypt')).toEqual({ type: 'nip44', method: 'encrypt' })
  })

  it('parses nip44.decrypt', () => {
    expect(parseMethod('nip44.decrypt')).toEqual({ type: 'nip44', method: 'decrypt' })
  })

  it('parses heartwood methods', () => {
    expect(parseMethod('heartwood_derive')).toEqual({ type: 'heartwood', method: 'heartwood_derive' })
    expect(parseMethod('heartwood_switch')).toEqual({ type: 'heartwood', method: 'heartwood_switch' })
    expect(parseMethod('heartwood_list_identities')).toEqual({ type: 'heartwood', method: 'heartwood_list_identities' })
  })

  it('returns unknown for unrecognised methods', () => {
    expect(parseMethod('foo')).toEqual({ type: 'unknown', method: 'foo' })
  })

  // Security: reject methods that look like valid prefixes but are not allowlisted
  it('rejects unknown nip44 sub-methods', () => {
    expect(parseMethod('nip44.deleteAll')).toEqual({ type: 'unknown', method: 'nip44.deleteAll' })
    expect(parseMethod('nip44.')).toEqual({ type: 'unknown', method: 'nip44.' })
  })

  it('rejects unknown heartwood methods', () => {
    expect(parseMethod('heartwood_evil')).toEqual({ type: 'unknown', method: 'heartwood_evil' })
    expect(parseMethod('heartwood_')).toEqual({ type: 'unknown', method: 'heartwood_' })
  })

  it('rejects empty strings', () => {
    expect(parseMethod('')).toEqual({ type: 'unknown', method: '' })
  })

  it('rejects prototype pollution attempts', () => {
    expect(parseMethod('__proto__')).toEqual({ type: 'unknown', method: '__proto__' })
    expect(parseMethod('constructor')).toEqual({ type: 'unknown', method: 'constructor' })
  })
})

describe('isValidHexPubkey', () => {
  const validPubkey = 'a'.repeat(64)

  it('accepts a valid 64-char hex string', () => {
    expect(isValidHexPubkey(validPubkey)).toBe(true)
    expect(isValidHexPubkey('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('rejects non-strings', () => {
    expect(isValidHexPubkey(null)).toBe(false)
    expect(isValidHexPubkey(undefined)).toBe(false)
    expect(isValidHexPubkey(123)).toBe(false)
    expect(isValidHexPubkey({})).toBe(false)
    expect(isValidHexPubkey([])).toBe(false)
  })

  it('rejects wrong-length hex strings', () => {
    expect(isValidHexPubkey('a'.repeat(63))).toBe(false)
    expect(isValidHexPubkey('a'.repeat(65))).toBe(false)
    expect(isValidHexPubkey('')).toBe(false)
  })

  it('rejects uppercase hex', () => {
    expect(isValidHexPubkey('A'.repeat(64))).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isValidHexPubkey('g'.repeat(64))).toBe(false)
    expect(isValidHexPubkey('a'.repeat(63) + 'z')).toBe(false)
  })
})

describe('isValidBunkerUri', () => {
  const validUri = `bunker://${'a'.repeat(64)}?relay=wss://relay.example.com`

  it('accepts a valid bunker URI', () => {
    expect(isValidBunkerUri(validUri)).toBe(true)
  })

  it('accepts a bunker URI without query params', () => {
    expect(isValidBunkerUri(`bunker://${'a'.repeat(64)}`)).toBe(true)
  })

  it('rejects non-strings', () => {
    expect(isValidBunkerUri(null)).toBe(false)
    expect(isValidBunkerUri(undefined)).toBe(false)
    expect(isValidBunkerUri(123)).toBe(false)
  })

  it('rejects wrong protocol', () => {
    expect(isValidBunkerUri(`http://${'a'.repeat(64)}`)).toBe(false)
    expect(isValidBunkerUri(`bunker:${'a'.repeat(64)}`)).toBe(false)
  })

  it('rejects short pubkeys', () => {
    expect(isValidBunkerUri(`bunker://${'a'.repeat(63)}`)).toBe(false)
  })

  it('rejects javascript: injection in URI', () => {
    expect(isValidBunkerUri('javascript:alert(1)')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidBunkerUri('')).toBe(false)
  })
})

describe('isValidPurpose', () => {
  it('accepts simple alphanumeric purposes', () => {
    expect(isValidPurpose('nostr')).toBe(true)
    expect(isValidPurpose('my-purpose')).toBe(true)
    expect(isValidPurpose('my_purpose_2')).toBe(true)
  })

  it('accepts single character', () => {
    expect(isValidPurpose('a')).toBe(true)
  })

  it('accepts maximum length (64 chars)', () => {
    expect(isValidPurpose('a'.repeat(64))).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidPurpose('')).toBe(false)
  })

  it('rejects too-long strings', () => {
    expect(isValidPurpose('a'.repeat(65))).toBe(false)
  })

  it('rejects strings with spaces', () => {
    expect(isValidPurpose('my purpose')).toBe(false)
  })

  it('rejects special characters', () => {
    expect(isValidPurpose('purpose;rm -rf /')).toBe(false)
    expect(isValidPurpose('../etc/passwd')).toBe(false)
    expect(isValidPurpose('<script>')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isValidPurpose(null)).toBe(false)
    expect(isValidPurpose(undefined)).toBe(false)
    expect(isValidPurpose(123)).toBe(false)
  })
})
