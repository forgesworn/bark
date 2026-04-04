import { describe, it, expect } from 'vitest'
import { DEFAULT_POLICIES, evaluatePolicy } from '../src/policy.js'

describe('evaluatePolicy', () => {
  // 1. Global default for signEvent with no overrides → 'allow'
  it('returns allow for signEvent with a non-protected kind via global default', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 1 }, 'https://example.com')
    expect(result).toBe('allow')
  })

  // 2. Global kind rules: kind 0, 3, 10002 → 'ask'
  it('returns ask for kind 0 via global kindRules', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, 'https://example.com')
    expect(result).toBe('ask')
  })

  it('returns ask for kind 3 via global kindRules', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 3 }, 'https://example.com')
    expect(result).toBe('ask')
  })

  it('returns ask for kind 10002 via global kindRules', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 10002 }, 'https://example.com')
    expect(result).toBe('ask')
  })

  // 3. Global default for getPublicKey → 'allow'
  it('returns allow for getPublicKey via global defaults', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'getPublicKey', null, 'https://example.com')
    expect(result).toBe('allow')
  })

  // 4. Global default for nip44 methods → 'allow'
  it('returns allow for nip44.encrypt via global defaults', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'nip44.encrypt', {}, 'https://example.com')
    expect(result).toBe('allow')
  })

  it('returns allow for nip44.decrypt via global defaults', () => {
    const result = evaluatePolicy(DEFAULT_POLICIES, 'nip44.decrypt', {}, 'https://example.com')
    expect(result).toBe('allow')
  })

  // 5. Site-specific default overrides global
  it('returns deny for all methods on a blocked site with site-level default', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://evil.example': {
          signEvent: 'deny',
          getPublicKey: 'deny',
        },
      },
    }
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://evil.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://evil.example')).toBe('deny')
  })

  // 6. Site-specific kindRule overrides site default
  it('site kindRule overrides site default (snort.social allows signEvent but kind 0 is ask)', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://snort.social': {
          signEvent: 'allow',
          kindRules: {
            '0': 'ask',
          },
        },
      },
    }
    // kind 1 → site default allow
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://snort.social')).toBe('allow')
    // kind 0 → site kindRule ask (overrides site default allow)
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://snort.social')).toBe('ask')
  })

  // 7. Site-specific kindRule overrides global kindRule
  it('site kindRule allow overrides global kindRule ask for kind 0', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://trusted.app': {
          kindRules: {
            '0': 'allow',
          },
        },
      },
    }
    // global kindRules says ask for kind 0, but site says allow
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://trusted.app')).toBe('allow')
  })

  // 8. Falls through to global default when site has no matching rule
  it('falls through to global default when site has no matching rule for the method', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://partial.app': {
          signEvent: 'ask',
          // no rule for getPublicKey
        },
      },
    }
    // getPublicKey not in site rules → global default allow
    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://partial.app')).toBe('allow')
  })

  // 9. Missing params for signEvent → 'allow' (no kind to match)
  it('returns global default allow for signEvent with null params (no kind to match)', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', null, 'https://example.com')).toBe('allow')
  })

  it('returns global default allow for signEvent with non-object params (no kind to match)', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', 'invalid', 'https://example.com')).toBe('allow')
  })

  // 10. Unknown/undefined origin → still applies global rules
  it('applies global kindRules even when origin is undefined', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, undefined)).toBe('ask')
  })

  it('applies global defaults even when origin is undefined', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'getPublicKey', null, undefined)).toBe('allow')
  })

  // 11. Blocked site blocks everything
  it('blocked site denies all methods when siteRules sets deny as method default', () => {
    const policies = {
      defaults: {
        getPublicKey: 'allow',
        signEvent: 'allow',
        'nip44.encrypt': 'allow',
        'nip44.decrypt': 'allow',
      },
      kindRules: {},
      siteRules: {
        'https://blocked.example': {
          getPublicKey: 'deny',
          signEvent: 'deny',
          'nip44.encrypt': 'deny',
          'nip44.decrypt': 'deny',
        },
      },
    }
    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip44.encrypt', {}, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip44.decrypt', {}, 'https://blocked.example')).toBe('deny')
  })

  // 12. DEFAULT_POLICIES has expected shape
  it('DEFAULT_POLICIES has the expected shape and values', () => {
    expect(DEFAULT_POLICIES).toMatchObject({
      defaults: {
        getPublicKey: 'allow',
        signEvent: 'allow',
        'nip44.encrypt': 'allow',
        'nip44.decrypt': 'allow',
      },
      kindRules: {
        '0': 'ask',
        '3': 'ask',
        '10002': 'ask',
      },
      siteRules: {},
    })
  })
})
