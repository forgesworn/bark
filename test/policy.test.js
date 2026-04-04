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

// ---------------------------------------------------------------------------
// Real-world scenario tests
// ---------------------------------------------------------------------------

describe('evaluatePolicy — real-world scenarios', () => {
  // Scenario: A user trusts Snort for everything except profile updates
  it('trusted site auto-signs most events but asks for profile metadata', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://snort.social': {
          signEvent: 'allow',
          getPublicKey: 'allow',
          'nip44.encrypt': 'allow',
          'nip44.decrypt': 'allow',
          kindRules: { '0': 'ask' },
        },
      },
    }
    // Normal note — auto-signs
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://snort.social')).toBe('allow')
    // Reaction — auto-signs
    expect(evaluatePolicy(policies, 'signEvent', { kind: 7 }, 'https://snort.social')).toBe('allow')
    // Profile update — site kindRule overrides site default → asks
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://snort.social')).toBe('ask')
    // Contact list — no site kindRule, but site default (signEvent: allow) beats
    // global kindRule. This is correct: trusting a site means trusting it for all
    // kinds unless you add explicit site-level kindRules for exceptions.
    expect(evaluatePolicy(policies, 'signEvent', { kind: 3 }, 'https://snort.social')).toBe('allow')
    // Relay list — same: site default wins over global kindRule
    expect(evaluatePolicy(policies, 'signEvent', { kind: 10002 }, 'https://snort.social')).toBe('allow')
    // DM encryption — auto
    expect(evaluatePolicy(policies, 'nip44.encrypt', {}, 'https://snort.social')).toBe('allow')
  })

  // Scenario: A malicious site is completely blocked
  it('blocked site gets deny for everything', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://phishing.example': {
          signEvent: 'deny',
          getPublicKey: 'deny',
          'nip44.encrypt': 'deny',
          'nip44.decrypt': 'deny',
        },
      },
    }
    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://phishing.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://phishing.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://phishing.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip44.encrypt', {}, 'https://phishing.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip44.decrypt', {}, 'https://phishing.example')).toBe('deny')
  })

  // Scenario: Unknown site hits global defaults — most things allowed, sensitive kinds ask
  it('unknown site uses global defaults and kind rules', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'getPublicKey', null, 'https://brand-new-client.com')).toBe('allow')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 1 }, 'https://brand-new-client.com')).toBe('allow')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, 'https://brand-new-client.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 3 }, 'https://brand-new-client.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 10002 }, 'https://brand-new-client.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'nip44.encrypt', {}, 'https://brand-new-client.com')).toBe('allow')
  })

  // Scenario: User adds custom kind protection (e.g. long-form articles)
  it('custom kind rules protect additional event kinds', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      kindRules: {
        ...DEFAULT_POLICIES.kindRules,
        '30023': 'ask',   // long-form articles
        '9735': 'ask',    // zap receipts
      },
    }
    expect(evaluatePolicy(policies, 'signEvent', { kind: 30023 }, 'https://habla.news')).toBe('ask')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 9735 }, 'https://habla.news')).toBe('ask')
    // Normal note still auto-signs
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://habla.news')).toBe('allow')
  })

  // Scenario: Site-specific trust overrides global kind protection
  it('fully trusted site can override even global kind protection', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://my-own-client.local': {
          signEvent: 'allow',
          kindRules: {
            '0': 'allow',
            '3': 'allow',
            '10002': 'allow',
          },
        },
      },
    }
    // All protected kinds auto-sign for this site
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://my-own-client.local')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 3 }, 'https://my-own-client.local')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 10002 }, 'https://my-own-client.local')).toBe('allow')
    // Same kinds still ask on other sites
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://other-client.com')).toBe('ask')
  })

  // Scenario: Priority chain — site kindRule beats everything
  it('priority chain: site kindRule > site default > global kindRule > global default', () => {
    const policies = {
      defaults: {
        signEvent: 'allow',   // level 4: global default
      },
      kindRules: {
        '1': 'ask',           // level 3: global kindRule
      },
      siteRules: {
        'https://test.com': {
          signEvent: 'deny',   // level 2: site default
          kindRules: {
            '1': 'allow',     // level 1: site kindRule (wins)
          },
        },
      },
    }
    // Site kindRule (allow) beats site default (deny) and global kindRule (ask)
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://test.com')).toBe('allow')
    // Without site kindRule, site default wins
    expect(evaluatePolicy(policies, 'signEvent', { kind: 7 }, 'https://test.com')).toBe('deny')
    // Different site, kind 1 hits global kindRule
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://other.com')).toBe('ask')
    // Different site, kind 7 hits global default
    expect(evaluatePolicy(policies, 'signEvent', { kind: 7 }, 'https://other.com')).toBe('allow')
  })

  // Edge case: kind as numeric 0 (falsy but valid)
  it('handles kind 0 correctly despite being falsy', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, 'https://x.com')).toBe('ask')
  })

  // Edge case: kind as string (some clients might pass string kinds)
  it('handles string kind values by converting to string key', () => {
    // kind: "0" should match kindRules["0"]
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: '0' }, 'https://x.com')).toBe('ask')
  })

  // Edge case: empty policies object
  it('handles empty/minimal policies gracefully', () => {
    expect(evaluatePolicy({}, 'signEvent', { kind: 1 }, 'https://x.com')).toBe('allow')
    expect(evaluatePolicy({ defaults: {} }, 'getPublicKey', null, 'https://x.com')).toBe('allow')
  })

  // Edge case: non-signEvent methods ignore kindRules
  it('kindRules only apply to signEvent, not other methods', () => {
    const policies = {
      defaults: { getPublicKey: 'allow' },
      kindRules: { '0': 'deny' },
      siteRules: {},
    }
    // getPublicKey should not be affected by kindRules even with kind-like params
    expect(evaluatePolicy(policies, 'getPublicKey', { kind: 0 }, 'https://x.com')).toBe('allow')
  })

  // Edge case: invalid action values in policies are skipped
  it('skips invalid action values and falls through', () => {
    const policies = {
      defaults: { signEvent: 'allow' },
      kindRules: { '1': 'invalid-action' },
      siteRules: {},
    }
    // Invalid kindRule skipped, falls to global default
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://x.com')).toBe('allow')
  })
})
