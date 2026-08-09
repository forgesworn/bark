import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { amoJwt, changelogSection, normaliseVersion } from '../scripts/store-lib.mjs'

const CHANGELOG = `# Changelog

All notable changes to Bark are documented here.

## [Unreleased]

## [1.3.7] — 2026-08-09

### Added

- The pairing QR carries a permission bundle.

## [1.3.6] — 2026-08-08

### Added

- Identity imports require confirmation.
`

describe('changelogSection', () => {
  it('extracts exactly one version, without its heading', () => {
    const section = changelogSection(CHANGELOG, 'v1.3.7')
    expect(section).toContain('permission bundle')
    expect(section).not.toContain('1.3.6')
    expect(section).not.toContain('## [')
  })

  it('accepts bare and v-prefixed versions alike', () => {
    expect(changelogSection(CHANGELOG, '1.3.6')).toContain('Identity imports')
  })

  it('returns empty for a version with no section', () => {
    expect(changelogSection(CHANGELOG, 'v9.9.9')).toBe('')
  })
})

describe('amoJwt', () => {
  it('mints a five-minute HS256 token AMO will accept', () => {
    const token = amoJwt('user:1:2', 'sekrit', 1_000_000, 'fixed-jti')
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url'))).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload, 'base64url'))).toEqual({
      iss: 'user:1:2', jti: 'fixed-jti', iat: 1_000_000, exp: 1_000_300,
    })
    const expected = createHmac('sha256', 'sekrit').update(`${header}.${payload}`).digest('base64url')
    expect(signature).toBe(expected)
  })

  it('mints a unique jti per call by default', () => {
    const a = amoJwt('user:1:2', 'sekrit')
    const b = amoJwt('user:1:2', 'sekrit')
    expect(a).not.toBe(b)
  })
})

describe('normaliseVersion', () => {
  it('normalises both spellings to tag + version', () => {
    expect(normaliseVersion('v1.3.7')).toEqual({ tag: 'v1.3.7', version: '1.3.7' })
    expect(normaliseVersion('1.3.7')).toEqual({ tag: 'v1.3.7', version: '1.3.7' })
  })

  it('rejects anything that is not a release version', () => {
    expect(() => normaliseVersion('main')).toThrow(/Not a release version/)
    expect(() => normaliseVersion('v1.3')).toThrow(/Not a release version/)
  })
})
