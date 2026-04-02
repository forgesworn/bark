import { describe, it, expect } from 'vitest'
import { parseMethod, isValidHexPubkey, isValidBunkerUri, isValidPurpose, sanitiseError, buildHeartwoodArgs, requiresApproval } from '../src/background.js'

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

describe('sanitiseError', () => {
  it('passes through known safe error prefixes', () => {
    expect(sanitiseError(new Error('No bunker URI configured. Open the Bark popup to connect.'))).toBe(
      'No bunker URI configured. Open the Bark popup to connect.',
    )
    expect(sanitiseError(new Error('Connection timed out.'))).toBe('Connection timed out.')
    expect(sanitiseError(new Error('Invalid method.'))).toBe('Invalid method.')
    expect(sanitiseError(new Error('Unknown method: foo'))).toBe('Unknown method: foo')
  })

  it('passes through heartwood_ prefixed errors', () => {
    expect(sanitiseError(new Error('heartwood_derive requires a valid purpose (alphanumeric, 1-64 chars).'))).toBe(
      'heartwood_derive requires a valid purpose (alphanumeric, 1-64 chars).',
    )
  })

  it('passes through nip44. prefixed errors', () => {
    expect(sanitiseError(new Error('nip44.encrypt requires pubkey and plaintext.'))).toBe(
      'nip44.encrypt requires pubkey and plaintext.',
    )
  })

  it('redacts unknown internal errors', () => {
    expect(sanitiseError(new Error('Cannot read property x of undefined'))).toBe('Request failed.')
    expect(sanitiseError(new Error('WebSocket connection failed at wss://relay.example.com'))).toBe('Request failed.')
    expect(sanitiseError(new Error('ECONNREFUSED 127.0.0.1:443'))).toBe('Request failed.')
  })

  it('handles plain string errors from nostr-tools NIP-46', () => {
    expect(sanitiseError('heartwood_derive requires a valid purpose')).toBe(
      'heartwood_derive requires a valid purpose',
    )
    expect(sanitiseError('Connection timed out.')).toBe('Connection timed out.')
    expect(sanitiseError('some internal nostr-tools error')).toBe('Request failed.')
  })

  it('handles missing or malformed error objects', () => {
    expect(sanitiseError(null)).toBe('Request failed.')
    expect(sanitiseError(undefined)).toBe('Request failed.')
    expect(sanitiseError({})).toBe('Request failed.')
    expect(sanitiseError({ message: '' })).toBe('Request failed.')
  })
})

describe('buildHeartwoodArgs', () => {
  it('returns empty array for heartwood_list_identities', () => {
    expect(buildHeartwoodArgs('heartwood_list_identities', {})).toEqual([])
    expect(buildHeartwoodArgs('heartwood_list_identities', null)).toEqual([])
  })

  it('returns [purpose, index] for heartwood_derive', () => {
    expect(buildHeartwoodArgs('heartwood_derive', { purpose: 'nostr', index: 0 })).toEqual(['nostr', '0'])
    expect(buildHeartwoodArgs('heartwood_derive', { purpose: 'my-key', index: 5 })).toEqual(['my-key', '5'])
  })

  it('returns [target] for heartwood_switch', () => {
    const pk = 'a'.repeat(64)
    expect(buildHeartwoodArgs('heartwood_switch', { target: pk })).toEqual([pk])
    expect(buildHeartwoodArgs('heartwood_switch', { target: 'npub1abc123' })).toEqual(['npub1abc123'])
    expect(buildHeartwoodArgs('heartwood_switch', { target: 'master' })).toEqual(['master'])
    expect(buildHeartwoodArgs('heartwood_switch', { target: 'social' })).toEqual(['social'])
  })

  it('throws on invalid purpose for heartwood_derive', () => {
    expect(() => buildHeartwoodArgs('heartwood_derive', { purpose: '', index: 0 })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_derive', { purpose: '../etc', index: 0 })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_derive', null)).toThrow()
  })

  it('throws on invalid index for heartwood_derive', () => {
    expect(() => buildHeartwoodArgs('heartwood_derive', { purpose: 'nostr', index: -1 })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_derive', { purpose: 'nostr', index: 1001 })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_derive', { purpose: 'nostr', index: 'abc' })).toThrow()
  })

  it('throws on invalid target for heartwood_switch', () => {
    expect(() => buildHeartwoodArgs('heartwood_switch', { target: '' })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_switch', { target: 'a'.repeat(257) })).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_switch', null)).toThrow()
    expect(() => buildHeartwoodArgs('heartwood_switch', { target: 123 })).toThrow()
  })

  it('throws on unknown heartwood method', () => {
    expect(() => buildHeartwoodArgs('heartwood_evil', {})).toThrow()
  })
})

describe('requiresApproval', () => {
  it('requires approval for getPublicKey', () => {
    expect(requiresApproval('getPublicKey', undefined)).toBe(true)
  })

  it('requires approval for signEvent with kind 0', () => {
    expect(requiresApproval('signEvent', { kind: 0, content: '{}' })).toBe(true)
  })

  it('does not require approval for signEvent with kind 1', () => {
    expect(requiresApproval('signEvent', { kind: 1, content: 'hello' })).toBe(false)
  })

  it('does not require approval for signEvent with kind 7', () => {
    expect(requiresApproval('signEvent', { kind: 7, content: '+' })).toBe(false)
  })

  it('does not require approval for nip44 methods', () => {
    expect(requiresApproval('nip44.encrypt', { pubkey: 'a'.repeat(64), plaintext: 'hi' })).toBe(false)
    expect(requiresApproval('nip44.decrypt', { pubkey: 'a'.repeat(64), ciphertext: 'x' })).toBe(false)
  })

  it('does not require approval for heartwood methods', () => {
    expect(requiresApproval('heartwood_list_identities', {})).toBe(false)
    expect(requiresApproval('heartwood_switch', { target: 'master' })).toBe(false)
  })

  it('does not require approval for signEvent with missing params', () => {
    expect(requiresApproval('signEvent', null)).toBe(false)
    expect(requiresApproval('signEvent', 'not-an-object')).toBe(false)
  })
})
