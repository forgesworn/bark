import { describe, it, expect } from 'vitest'
import { createRelayRefusals, describeRelayRefusals, cleanRelayReason, relayHost, looksLikeAddressBlock, REFUSAL_MESSAGE_PREFIX } from '../src/relay-refusals.js'
import { explainWithRelayRefusals, RequestTimeoutError, RelayRefusedError, sanitiseError } from '../src/background.js'

const BANNED = 'banned: too many rate-limit violations, try again later'

describe('relay refusals', () => {
  it('names the relay and advises another network when a relay bans the address', () => {
    const refusals = createRelayRefusals({ now: () => 1_000 })
    refusals.refused('wss://relay.damus.io/', new Error(BANNED))
    const message = describeRelayRefusals(refusals.recent(['wss://relay.damus.io']))
    expect(message).toBe(`${REFUSAL_MESSAGE_PREFIX}: relay.damus.io said "${BANNED}". Your network address may be blocked there. Try another network or VPN server.`)
  })

  it('forgets a refusal once the relay accepts, or after the window', () => {
    let t = 0
    const refusals = createRelayRefusals({ now: () => t, windowMs: 100 })
    refusals.refused('wss://a.example', 'rate-limited: slow down')
    refusals.accepted('wss://a.example/')
    expect(refusals.recent()).toEqual([])
    refusals.refused('wss://b.example', 'blocked')
    t = 101
    expect(refusals.recent()).toEqual([])
  })

  it('only reports relays the signer uses', () => {
    const refusals = createRelayRefusals({ now: () => 0 })
    refusals.refused('wss://other.example', 'banned')
    expect(refusals.recent(['wss://relay.damus.io'])).toEqual([])
  })

  it('keeps relay text short and free of paths and control characters', () => {
    expect(cleanRelayReason('see /etc/passwd\n\u0007now')).toBe('see etc passwd now')
    expect(cleanRelayReason('x'.repeat(300))).toHaveLength(100)
    expect(relayHost('wss://relay.example:443/path')).toBe('relay.example')
    expect(looksLikeAddressBlock('auth-required: sign in')).toBe(false)
  })
})

describe('explainWithRelayRefusals', () => {
  it('turns a bare timeout into the refusal behind it, and the message survives sanitising', () => {
    const refusals = createRelayRefusals({ now: () => 0 })
    refusals.refused('wss://relay.damus.io', BANNED)
    const err = explainWithRelayRefusals(new RequestTimeoutError('Sign request timed out.'), ['wss://relay.damus.io'], refusals)
    expect(err).toBeInstanceOf(RelayRefusedError)
    expect(sanitiseError(err)).toContain('relay.damus.io said')
  })

  it('leaves the error alone when nothing was refused, or when the signer answered with an error', () => {
    const refusals = createRelayRefusals({ now: () => 0 })
    const timeout = new RequestTimeoutError('Sign request timed out.')
    expect(explainWithRelayRefusals(timeout, ['wss://relay.damus.io'], refusals)).toBe(timeout)
    refusals.refused('wss://relay.damus.io', BANNED)
    const denied = new Error('user denied')
    expect(explainWithRelayRefusals(denied, ['wss://relay.damus.io'], refusals)).toBe(denied)
  })
})
