import { describe, it, expect } from 'vitest'
import { parseMethod, isValidHexPubkey, isValidBunkerUri, isValidPurpose, normaliseSignEventTemplate, sanitiseError, buildHeartwoodArgs, checkApproval, migrateStorage, makeInstanceId, normaliseAddress, appNameFromOrigin, buildConnectMetadata, buildConnectParams, originFromSender, isRelayPublishFailure, buildSignerHealthEvent, safeInstanceName, normaliseHeartwoodIdentity, normaliseHeartwoodIdentities, buildHeartwoodIdentityInstances, isUnsupportedHeartwoodProbeError, approvalBadgeText, normaliseNostrConnectRelays, buildNostrConnectRequest, DEFAULT_NOSTRCONNECT_RELAYS, isInternalSender } from '../src/background.js'

describe('parseMethod', () => {
  it('parses getPublicKey', () => {
    expect(parseMethod('getPublicKey')).toEqual({ type: 'nip07', method: 'getPublicKey' })
  })

  it('parses getRelays', () => {
    expect(parseMethod('getRelays')).toEqual({ type: 'nip07', method: 'getRelays' })
  })

  it('parses signEvent', () => {
    expect(parseMethod('signEvent')).toEqual({ type: 'nip07', method: 'signEvent' })
  })

  it('parses nip04 methods', () => {
    expect(parseMethod('nip04.encrypt')).toEqual({ type: 'nip04', method: 'encrypt' })
    expect(parseMethod('nip04.decrypt')).toEqual({ type: 'nip04', method: 'decrypt' })
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

  it('rejects unknown nip04 sub-methods', () => {
    expect(parseMethod('nip04.deleteAll')).toEqual({ type: 'unknown', method: 'nip04.deleteAll' })
    expect(parseMethod('nip04.')).toEqual({ type: 'unknown', method: 'nip04.' })
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

  it('accepts localhost WebSocket relay bunker URIs for local bridge signers', () => {
    expect(isValidBunkerUri(`bunker://${'a'.repeat(64)}?relay=ws://127.0.0.1:49152&secret=local-slot`)).toBe(true)
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

  it('rejects double question marks', () => {
    expect(isValidBunkerUri(`bunker://${'a'.repeat(64)}??relay=wss://r.com`)).toBe(false)
  })

  it('rejects URIs exceeding length limit', () => {
    const longQuery = 'relay=' + 'a'.repeat(3000)
    expect(isValidBunkerUri(`bunker://${'a'.repeat(64)}?${longQuery}`)).toBe(false)
  })

  it('rejects empty query string after ?', () => {
    expect(isValidBunkerUri(`bunker://${'a'.repeat(64)}?`)).toBe(false)
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

describe('normaliseSignEventTemplate', () => {
  it('fills created_at and tags for NIP-07 event templates', () => {
    const event = normaliseSignEventTemplate({
      kind: 21236,
      content: '',
      tags: [['challenge', 'abc']],
      pubkey: 'x'.repeat(64),
      sig: 'y'.repeat(128),
      id: 'z'.repeat(64),
    })

    expect(event.kind).toBe(21236)
    expect(event.content).toBe('')
    expect(event.tags).toEqual([['challenge', 'abc']])
    expect(Number.isInteger(event.created_at)).toBe(true)
    expect(event.pubkey).toBeUndefined()
    expect(event.sig).toBeUndefined()
    expect(event.id).toBeUndefined()
  })

  it('preserves caller supplied created_at', () => {
    expect(normaliseSignEventTemplate({ kind: 1, content: 'hi', created_at: 123, tags: [] })).toEqual({
      kind: 1,
      content: 'hi',
      tags: [],
      created_at: 123,
    })
  })

  it('coerces a millisecond created_at to seconds (coinos login bug)', () => {
    // coinos builds its kind-27235 auth event with created_at: Date.now().
    const event = normaliseSignEventTemplate({
      kind: 27235,
      content: '',
      tags: [['u', 'https://coinos.io/api/nostrAuth']],
      created_at: 1778326067724,
    })
    expect(event.created_at).toBe(1778326067)
  })

  it('treats the 10^10 boundary as seconds, not milliseconds', () => {
    expect(normaliseSignEventTemplate({ kind: 1, content: '', tags: [], created_at: 10_000_000_000 }).created_at).toBe(10_000_000_000)
  })

  it('rejects malformed templates before hitting the bunker', () => {
    expect(() => normaliseSignEventTemplate(null)).toThrow(/event object/)
    expect(() => normaliseSignEventTemplate({ kind: '1' })).toThrow(/numeric kind/)
    expect(() => normaliseSignEventTemplate({ kind: 1, tags: 'bad' })).toThrow(/array tags/)
  })
})

describe('buildSignerHealthEvent', () => {
  it('builds a non-published signer health event', () => {
    const event = buildSignerHealthEvent('challenge-123')

    expect(event.kind).toBe(22242)
    expect(event.content).toBe('')
    expect(event.tags).toContainEqual(['relay', 'bark://extension'])
    expect(event.tags).toContainEqual(['challenge', 'challenge-123'])
    expect(event.tags).toContainEqual(['purpose', 'signer-health-check'])
    expect(Number.isInteger(event.created_at)).toBe(true)
  })
})

describe('isRelayPublishFailure', () => {
  it('detects nostr-tools relay connection failures that resolve as strings', () => {
    expect(isRelayPublishFailure('connection failure: Error: failed')).toBe(true)
  })

  it('does not treat normal relay OK strings as failures', () => {
    expect(isRelayPublishFailure('OK')).toBe(false)
    expect(isRelayPublishFailure('duplicate url')).toBe(false)
    expect(isRelayPublishFailure(new Error('connection failure: nope'))).toBe(false)
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

  it('redacts errors containing file paths or URLs', () => {
    expect(sanitiseError(new Error('WebSocket connection failed at wss://relay.example.com'))).toBe('Request failed.')
    expect(sanitiseError(new Error('ENOENT: no such file, open /home/user/.config'))).toBe('Request failed.')
    expect(sanitiseError(new Error('module not found at C:\\Users\\foo\\bar'))).toBe('Request failed.')
  })

  it('redacts excessively long error messages', () => {
    expect(sanitiseError(new Error('x'.repeat(121)))).toBe('Request failed.')
  })

  it('passes through short signer errors without paths', () => {
    expect(sanitiseError(new Error('identity not found in cache'))).toBe('identity not found in cache')
    expect(sanitiseError(new Error('not available in bunker mode'))).toBe('not available in bunker mode')
    expect(sanitiseError(new Error('ECONNREFUSED 127.0.0.1:443'))).toBe('ECONNREFUSED 127.0.0.1:443')
  })

  it('handles plain string errors from nostr-tools NIP-46', () => {
    expect(sanitiseError('heartwood_derive requires a valid purpose')).toBe(
      'heartwood_derive requires a valid purpose',
    )
    expect(sanitiseError('Connection timed out.')).toBe('Connection timed out.')
    expect(sanitiseError('identity not found in cache')).toBe('identity not found in cache')
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

describe('checkApproval', () => {
  it('returns ask for getPublicKey with default policies', async () => {
    expect(await checkApproval('getPublicKey', undefined, 'https://example.com')).toBe('ask')
  })

  it('returns ask for signEvent kind 0 with default policies', async () => {
    expect(await checkApproval('signEvent', { kind: 0 }, 'https://example.com')).toBe('ask')
  })

  it('returns ask for signEvent kind 3 with default policies', async () => {
    expect(await checkApproval('signEvent', { kind: 3 }, 'https://example.com')).toBe('ask')
  })

  it('returns ask for signEvent kind 10002 with default policies', async () => {
    expect(await checkApproval('signEvent', { kind: 10002 }, 'https://example.com')).toBe('ask')
  })

  it('returns ask for signEvent kind 1 with default policies', async () => {
    expect(await checkApproval('signEvent', { kind: 1 }, 'https://example.com')).toBe('ask')
  })

  it('returns ask for nip44 methods with default policies', async () => {
    expect(await checkApproval('nip44.encrypt', {}, 'https://example.com')).toBe('ask')
    expect(await checkApproval('nip44.decrypt', {}, 'https://example.com')).toBe('ask')
  })

  it('returns ask for getRelays and nip04 methods with default policies', async () => {
    expect(await checkApproval('getRelays', {}, 'https://example.com')).toBe('ask')
    expect(await checkApproval('nip04.encrypt', {}, 'https://example.com')).toBe('ask')
    expect(await checkApproval('nip04.decrypt', {}, 'https://example.com')).toBe('ask')
  })
})

describe('normaliseNostrConnectRelays', () => {
  it('accepts wss relays from a string with commas, spaces, or newlines', () => {
    expect(normaliseNostrConnectRelays('wss://relay.nsec.app, wss://relay.damus.io\nwss://nos.lol')).toEqual([
      'wss://relay.nsec.app',
      'wss://relay.damus.io',
      'wss://nos.lol',
    ])
  })

  it('accepts an array input', () => {
    expect(normaliseNostrConnectRelays(['wss://relay.nsec.app'])).toEqual(['wss://relay.nsec.app'])
  })

  it('strips trailing slashes and deduplicates', () => {
    expect(normaliseNostrConnectRelays('wss://relay.nsec.app/ wss://relay.nsec.app')).toEqual([
      'wss://relay.nsec.app',
    ])
  })

  it('allows plain ws only for loopback bridges', () => {
    expect(normaliseNostrConnectRelays('ws://localhost:7777 ws://127.0.0.1:8080')).toEqual([
      'ws://localhost:7777',
      'ws://127.0.0.1:8080',
    ])
    expect(normaliseNostrConnectRelays('ws://evil.example.com')).toEqual([])
  })

  it('rejects non-websocket URLs and junk', () => {
    expect(normaliseNostrConnectRelays('https://relay.nsec.app not-a-url javascript:alert(1)')).toEqual([])
  })

  it('caps the list at four relays', () => {
    const input = Array.from({ length: 6 }, (_, i) => `wss://relay${i}.example.com`)
    expect(normaliseNostrConnectRelays(input)).toHaveLength(4)
  })

  it('has valid defaults', () => {
    expect(normaliseNostrConnectRelays(DEFAULT_NOSTRCONNECT_RELAYS)).toEqual(DEFAULT_NOSTRCONNECT_RELAYS)
  })
})

describe('buildNostrConnectRequest', () => {
  it('builds a nostrconnect URI with client pubkey, relay, secret, and metadata', () => {
    const { uri, clientSecret, relays, secret } = buildNostrConnectRequest('wss://relay.nsec.app')
    expect(uri).toMatch(/^nostrconnect:\/\/[0-9a-f]{64}\?/)
    expect(clientSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(relays).toEqual(['wss://relay.nsec.app'])
    expect(secret).toMatch(/^[0-9a-f]{32}$/)

    const parsed = new URL(uri)
    expect(parsed.searchParams.getAll('relay')).toEqual(['wss://relay.nsec.app'])
    expect(parsed.searchParams.get('secret')).toBe(secret)
    expect(parsed.searchParams.get('name')).toBe('Bark')
  })

  it('generates a fresh keypair and secret per request', () => {
    const a = buildNostrConnectRequest('wss://relay.nsec.app')
    const b = buildNostrConnectRequest('wss://relay.nsec.app')
    expect(a.clientSecret).not.toBe(b.clientSecret)
    expect(a.secret).not.toBe(b.secret)
  })

  it('throws a safe error when no valid relay is given', () => {
    expect(() => buildNostrConnectRequest('http://nope')).toThrow(/Invalid relay address/)
    expect(sanitiseError(new Error('Invalid relay address. Use wss:// relay URLs.')))
      .toBe('Invalid relay address. Use wss:// relay URLs.')
  })
})

describe('approvalBadgeText', () => {
  it('returns empty string for zero, negative, or invalid counts', () => {
    expect(approvalBadgeText(0)).toBe('')
    expect(approvalBadgeText(-1)).toBe('')
    expect(approvalBadgeText(1.5)).toBe('')
    expect(approvalBadgeText(NaN)).toBe('')
  })

  it('returns the count as a string up to nine', () => {
    expect(approvalBadgeText(1)).toBe('1')
    expect(approvalBadgeText(9)).toBe('9')
  })

  it('caps the display at 9+', () => {
    expect(approvalBadgeText(10)).toBe('9+')
    expect(approvalBadgeText(42)).toBe('9+')
  })
})

describe('makeInstanceId', () => {
  it('builds id from name and bunker pubkey', () => {
    const uri = 'bunker://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890?relay=wss://r.com'
    expect(makeInstanceId('personal', uri)).toBe('personal-abcdef12')
  })

  it('sanitises unsafe names for stable ids', () => {
    const uri = 'bunker://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890?relay=wss://r.com'
    expect(makeInstanceId('my persona!', uri)).toBe('my-persona-abcdef12')
  })
})

describe('Heartwood identity import helpers', () => {
  const masterPubkey = 'a'.repeat(64)
  const socialPubkey = 'b'.repeat(64)
  const masterUri = `bunker://${masterPubkey}?relay=wss://relay.example.com`
  const socialUri = `bunker://${socialPubkey}?relay=wss://relay.example.com&secret=slot-secret`

  it('sanitises display names without dropping useful separators', () => {
    expect(safeInstanceName(' social profile ')).toBe('social-profile')
    expect(safeInstanceName('heartwood:social.1')).toBe('heartwood:social.1')
    expect(safeInstanceName('')).toBe('heartwood')
  })

  it('normalises a valid Heartwood identity manifest entry', () => {
    expect(normaliseHeartwoodIdentity({
      label: 'social',
      pubkey: socialPubkey,
      npub: 'npub1abc',
      uri: socialUri,
    })).toEqual({
      label: 'social',
      pubkey: socialPubkey,
      npub: 'npub1abc',
      uri: socialUri,
    })
  })

  it('rejects malformed or mismatched Heartwood identity records', () => {
    expect(normaliseHeartwoodIdentity(null)).toBeNull()
    expect(normaliseHeartwoodIdentity({ label: 'bad', uri: 'https://example.com' })).toBeNull()
    expect(normaliseHeartwoodIdentity({
      label: 'bad',
      pubkey: masterPubkey,
      uri: socialUri,
    })).toBeNull()
  })

  it('accepts both array and { identities } Heartwood identity payloads', () => {
    expect(normaliseHeartwoodIdentities([
      { label: 'master', pubkey: masterPubkey, uri: masterUri },
    ])).toHaveLength(1)
    expect(normaliseHeartwoodIdentities({
      identities: [{ label: 'social', pubkey: socialPubkey, uri: socialUri }],
    })[0].label).toBe('social')
  })

  it('builds Bark instances from Heartwood per-identity bunker URIs', () => {
    const instances = buildHeartwoodIdentityInstances({
      identities: [
        { label: 'master', pubkey: masterPubkey, npub: 'npub1master', uri: masterUri },
        { label: 'social', pubkey: socialPubkey, npub: 'npub1social', uri: socialUri },
      ],
    }, {
      address: 'http://heartwood.local:3000',
      baseName: 'heartwood',
      clientSecret: 'ff'.repeat(32),
    })

    expect(instances).toHaveLength(2)
    expect(instances[0]).toMatchObject({
      id: 'heartwood-aaaaaaaa',
      name: 'heartwood',
      address: 'http://heartwood.local:3000',
      bunkerUri: masterUri,
      clientSecret: 'ff'.repeat(32),
      npub: 'npub1master',
      isHeartwood: true,
      heartwoodBaseName: 'heartwood',
      heartwoodIdentityLabel: 'master',
      heartwoodIdentityPubkey: masterPubkey,
    })
    expect(instances[1]).toMatchObject({
      id: 'heartwood:social-bbbbbbbb',
      name: 'heartwood:social',
      bunkerUri: socialUri,
      heartwoodIdentityLabel: 'social',
      heartwoodIdentityPubkey: socialPubkey,
    })
  })
})

describe('migrateStorage', () => {
  it('converts legacy single-connection fields to instances array', () => {
    const legacy = {
      bunkerUri: 'bunker://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890?relay=wss://r.com',
      clientSecret: 'ff'.repeat(32),
      isHeartwood: true,
    }
    const result = migrateStorage(legacy)
    expect(result.instances).toHaveLength(1)
    expect(result.instances[0].id).toBe('legacy-abcdef12')
    expect(result.instances[0].bunkerUri).toBe(legacy.bunkerUri)
    expect(result.instances[0].clientSecret).toBe(legacy.clientSecret)
    expect(result.activeInstanceId).toBe(result.instances[0].id)
    expect(result.removeKeys).toEqual(['bunkerUri', 'clientSecret', 'isHeartwood'])
  })

  it('returns null when no legacy fields present', () => {
    expect(migrateStorage({})).toBeNull()
    expect(migrateStorage({ instances: [] })).toBeNull()
  })
})

describe('normaliseAddress', () => {
  it('prepends http:// when no scheme', () => {
    expect(normaliseAddress('mypi.local:3000')).toBe('http://mypi.local:3000')
  })

  it('preserves existing http scheme', () => {
    expect(normaliseAddress('http://mypi.local:3000')).toBe('http://mypi.local:3000')
  })

  it('preserves https scheme', () => {
    expect(normaliseAddress('https://my.server.com')).toBe('https://my.server.com')
  })

  it('strips trailing slash', () => {
    expect(normaliseAddress('http://mypi.local:3000/')).toBe('http://mypi.local:3000')
  })

  it('handles onion addresses', () => {
    expect(normaliseAddress('http://abc123.onion:3000/')).toBe('http://abc123.onion:3000')
  })

  it('rejects empty input', () => {
    expect(() => normaliseAddress('')).toThrow('Invalid address.')
  })

  it('rejects whitespace-only input', () => {
    expect(() => normaliseAddress('   ')).toThrow('Invalid address.')
  })

  it('validates the resulting URL is parseable', () => {
    // Valid addresses should not throw
    expect(() => normaliseAddress('192.168.1.1:3000')).not.toThrow()
    expect(() => normaliseAddress('localhost:3000')).not.toThrow()
  })
})

describe('sanitiseError — safe prefix coverage', () => {
  it('passes through new safe prefixes', () => {
    expect(sanitiseError(new Error('Invalid address.'))).toBe('Invalid address.')
    expect(sanitiseError(new Error('Invalid request origin.'))).toBe('Invalid request origin.')
    expect(sanitiseError(new Error('Instance not found.'))).toBe('Instance not found.')
    expect(sanitiseError(new Error('Server returned an invalid bunker URI.'))).toBe('Server returned an invalid bunker URI.')
    expect(sanitiseError(new Error('Active identity changed. Please retry.'))).toBe('Active identity changed. Please retry.')
  })
})

describe('isInternalSender', () => {
  const base = 'chrome-extension://abcdefghijklmnop/'

  it('treats tabless senders as internal', () => {
    expect(isInternalSender({}, base)).toBe(true)
    expect(isInternalSender({ origin: 'https://evil.example' }, base)).toBe(true)
  })

  it('treats extension pages opened in a tab as internal', () => {
    expect(isInternalSender({ tab: { id: 1 }, origin: 'chrome-extension://abcdefghijklmnop' }, base)).toBe(true)
  })

  it('treats web pages as external', () => {
    expect(isInternalSender({ tab: { id: 1 }, origin: 'https://snort.social' }, base)).toBe(false)
    expect(isInternalSender({ tab: { id: 1 }, origin: 'chrome-extension://otherextension' }, base)).toBe(false)
    expect(isInternalSender({ tab: { id: 1 } }, base)).toBe(false)
    expect(isInternalSender({ tab: { id: 1 }, origin: '' }, base)).toBe(false)
  })
})

describe('originFromSender', () => {
  it('uses sender.origin when it is an http origin', () => {
    expect(originFromSender({
      origin: 'https://example.com',
      tab: { url: 'https://other.example/path' },
    })).toBe('https://example.com')
  })

  it('canonicalizes tab URLs when sender.origin is unavailable', () => {
    expect(originFromSender({
      tab: { url: 'https://example.com/some/path?x=1#hash' },
    })).toBe('https://example.com')
  })

  it('preserves localhost ports', () => {
    expect(originFromSender({
      origin: 'http://localhost:5173',
    })).toBe('http://localhost:5173')
  })

  it('rejects extension, file, and malformed origins', () => {
    expect(originFromSender({ origin: 'chrome-extension://abc' })).toBeNull()
    expect(originFromSender({ tab: { url: 'file:///tmp/page.html' } })).toBeNull()
    expect(originFromSender({ origin: 'not-a-url' })).toBeNull()
  })
})

describe('appNameFromOrigin', () => {
  it('extracts hostname from https origin', () => {
    expect(appNameFromOrigin('https://nostrudel.ninja')).toBe('nostrudel.ninja')
  })

  it('extracts hostname from http origin', () => {
    expect(appNameFromOrigin('http://localhost:3000')).toBe('localhost')
  })

  it('strips leading www.', () => {
    expect(appNameFromOrigin('https://www.snort.social')).toBe('snort.social')
  })

  it('falls back to Bark for non-http schemes', () => {
    expect(appNameFromOrigin('chrome-extension://abc123')).toBe('Bark')
  })

  it('falls back to Bark for undefined', () => {
    expect(appNameFromOrigin(undefined)).toBe('Bark')
  })

  it('falls back to Bark for empty string', () => {
    expect(appNameFromOrigin('')).toBe('Bark')
  })

  it('falls back to Bark for non-URL strings', () => {
    expect(appNameFromOrigin('not-a-url')).toBe('Bark')
  })
})

describe('buildConnectMetadata', () => {
  it('returns name and url for a valid https origin', () => {
    const meta = buildConnectMetadata('https://nostrudel.ninja')
    expect(meta.name).toBe('nostrudel.ninja')
    expect(meta.url).toBe('https://nostrudel.ninja')
  })

  it('uses bark://extension as url for non-http origins', () => {
    const meta = buildConnectMetadata('chrome-extension://abc')
    expect(meta.name).toBe('Bark')
    expect(meta.url).toBe('bark://extension')
  })

  it('uses bark://extension as url when origin is undefined', () => {
    const meta = buildConnectMetadata(undefined)
    expect(meta.name).toBe('Bark')
    expect(meta.url).toBe('bark://extension')
  })

  it('result is JSON-serialisable', () => {
    const meta = buildConnectMetadata('https://iris.to')
    expect(() => JSON.stringify(meta)).not.toThrow()
    const parsed = JSON.parse(JSON.stringify(meta))
    expect(parsed.name).toBe('iris.to')
    expect(parsed.url).toBe('https://iris.to')
  })
})

describe('buildConnectParams', () => {
  it('places client metadata in the fourth NIP-46 connect parameter', () => {
    const meta = buildConnectMetadata('https://nostrudel.ninja')
    expect(buildConnectParams({ pubkey: 'a'.repeat(64), secret: 'pair-secret' }, meta)).toEqual([
      'a'.repeat(64),
      'pair-secret',
      '',
      JSON.stringify(meta),
    ])
  })

  it('uses an empty secret when the bunker URI has none', () => {
    const meta = buildConnectMetadata(undefined)
    expect(buildConnectParams({ pubkey: 'a'.repeat(64) }, meta)[1]).toBe('')
  })
})

describe('isUnsupportedHeartwoodProbeError', () => {
  it('treats optional Heartwood probe timeouts and unsupported-method errors as standard bunker mode', () => {
    expect(isUnsupportedHeartwoodProbeError('Heartwood identity probe timed out.')).toBe(true)
    expect(isUnsupportedHeartwoodProbeError('unknown method: heartwood_list_identities')).toBe(true)
    expect(isUnsupportedHeartwoodProbeError('method not supported')).toBe(true)
    expect(isUnsupportedHeartwoodProbeError('unrecognised method')).toBe(true)
    expect(isUnsupportedHeartwoodProbeError('unrecognized method')).toBe(true)
  })

  it('does not hide approval or signer errors as unsupported Heartwood capability', () => {
    expect(isUnsupportedHeartwoodProbeError('client not approved')).toBe(false)
    expect(isUnsupportedHeartwoodProbeError('Request failed.')).toBe(false)
    expect(isUnsupportedHeartwoodProbeError('')).toBe(false)
  })
})
