import { describe, it, expect } from 'vitest'
import { parseMethod } from '../src/background.js'

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
})
