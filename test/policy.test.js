import { describe, it, expect } from 'vitest'
import {
  buildTrustedSiteRule,
  DEFAULT_POLICIES,
  evaluatePolicy,
  nextPolicyAction,
  normalisePolicies,
  POLICY_VERSION,
} from '../src/policy.js'

describe('nextPolicyAction', () => {
  it('cycles allow → ask → deny → allow', () => {
    expect(nextPolicyAction('allow')).toBe('ask')
    expect(nextPolicyAction('ask')).toBe('deny')
    expect(nextPolicyAction('deny')).toBe('allow')
  })

  it('starts the cycle at allow for invalid input', () => {
    expect(nextPolicyAction(undefined)).toBe('allow')
    expect(nextPolicyAction('nonsense')).toBe('allow')
  })
})

describe('evaluatePolicy', () => {
  it('asks for first-use NIP-07 and encryption methods by default', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'getPublicKey', null, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'getRelays', null, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 1 }, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'nip04.encrypt', {}, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'nip04.decrypt', {}, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'nip44.encrypt', {}, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'nip44.decrypt', {}, 'https://example.com')).toBe('ask')
  })

  it('asks for protected event kinds through global kind rules', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 3 }, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 10002 }, 'https://example.com')).toBe('ask')
  })

  it('trusted site defaults allow routine methods but protected kinds still ask', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://snort.social': buildTrustedSiteRule(),
      },
    }

    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://snort.social')).toBe('allow')
    expect(evaluatePolicy(policies, 'getRelays', null, 'https://snort.social')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://snort.social')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 7 }, 'https://snort.social')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://snort.social')).toBe('ask')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 3 }, 'https://snort.social')).toBe('ask')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 10002 }, 'https://snort.social')).toBe('ask')
    expect(evaluatePolicy(policies, 'nip44.decrypt', {}, 'https://snort.social')).toBe('allow')
  })

  it('site-specific kind rules override global kind rules', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://trusted.app': {
          signEvent: 'allow',
          kindRules: {
            '0': 'allow',
            '3': 'deny',
          },
        },
      },
    }

    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://trusted.app')).toBe('allow')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 3 }, 'https://trusted.app')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 10002 }, 'https://trusted.app')).toBe('ask')
  })

  it('site-level deny blocks protected and unprotected events', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://blocked.example': {
          getPublicKey: 'deny',
          getRelays: 'deny',
          signEvent: 'deny',
          'nip04.encrypt': 'deny',
          'nip04.decrypt': 'deny',
          'nip44.encrypt': 'deny',
          'nip44.decrypt': 'deny',
        },
      },
    }

    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'getRelays', null, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 0 }, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip04.encrypt', {}, 'https://blocked.example')).toBe('deny')
    expect(evaluatePolicy(policies, 'nip44.decrypt', {}, 'https://blocked.example')).toBe('deny')
  })

  it('falls through to global defaults when a partial site rule has no method match', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      siteRules: {
        'https://partial.app': {
          signEvent: 'allow',
        },
      },
    }

    expect(evaluatePolicy(policies, 'getPublicKey', null, 'https://partial.app')).toBe('ask')
  })

  it('handles missing or malformed signEvent params through the method default', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', null, 'https://example.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', 'invalid', 'https://example.com')).toBe('ask')
  })

  it('applies global rules when origin is undefined', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, undefined)).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'getPublicKey', null, undefined)).toBe('ask')
  })

  it('denies unknown methods by fallback', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'unknown.method', null, 'https://example.com')).toBe('deny')
  })

  it('has the expected default policy shape', () => {
    expect(DEFAULT_POLICIES).toMatchObject({
      version: POLICY_VERSION,
      defaults: {
        getPublicKey: 'ask',
        getRelays: 'ask',
        signEvent: 'ask',
        'nip04.encrypt': 'ask',
        'nip04.decrypt': 'ask',
        'nip44.encrypt': 'ask',
        'nip44.decrypt': 'ask',
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

describe('evaluatePolicy — edge cases', () => {
  it('protects custom event kinds', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      kindRules: {
        ...DEFAULT_POLICIES.kindRules,
        '30023': 'ask',
        '9735': 'ask',
      },
      siteRules: {
        'https://habla.news': buildTrustedSiteRule(),
      },
    }

    expect(evaluatePolicy(policies, 'signEvent', { kind: 30023 }, 'https://habla.news')).toBe('ask')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 9735 }, 'https://habla.news')).toBe('ask')
    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://habla.news')).toBe('allow')
  })

  it('handles kind 0 and string kind values', () => {
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: 0 }, 'https://x.com')).toBe('ask')
    expect(evaluatePolicy(DEFAULT_POLICIES, 'signEvent', { kind: '0' }, 'https://x.com')).toBe('ask')
  })

  it('normalises empty/minimal policies to safe defaults', () => {
    expect(evaluatePolicy({}, 'signEvent', { kind: 1 }, 'https://x.com')).toBe('ask')
    expect(evaluatePolicy({ defaults: {} }, 'getPublicKey', null, 'https://x.com')).toBe('ask')
  })

  it('kind rules only apply to signEvent', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      defaults: { ...DEFAULT_POLICIES.defaults, getPublicKey: 'allow' },
      kindRules: { '0': 'deny' },
      siteRules: {},
    }

    expect(evaluatePolicy(policies, 'getPublicKey', { kind: 0 }, 'https://x.com')).toBe('allow')
  })

  it('skips invalid action values and falls through', () => {
    const policies = {
      ...DEFAULT_POLICIES,
      defaults: { ...DEFAULT_POLICIES.defaults, signEvent: 'allow' },
      kindRules: { '1': 'invalid-action' },
      siteRules: {},
    }

    expect(evaluatePolicy(policies, 'signEvent', { kind: 1 }, 'https://x.com')).toBe('allow')
  })
})

describe('normalisePolicies', () => {
  it('migrates old permissive policy defaults to current ask defaults', () => {
    const oldPolicies = {
      defaults: {
        getPublicKey: 'allow',
        signEvent: 'allow',
      },
      kindRules: {
        '30023': 'ask',
      },
      siteRules: {
        'https://trusted.app': {
          signEvent: 'allow',
        },
      },
    }

    expect(normalisePolicies(oldPolicies)).toMatchObject({
      version: POLICY_VERSION,
      defaults: DEFAULT_POLICIES.defaults,
      kindRules: {
        ...DEFAULT_POLICIES.kindRules,
        '30023': 'ask',
      },
      siteRules: oldPolicies.siteRules,
    })
  })

  it('preserves current-version explicit defaults', () => {
    const current = {
      ...DEFAULT_POLICIES,
      defaults: {
        ...DEFAULT_POLICIES.defaults,
        getPublicKey: 'allow',
      },
    }

    expect(normalisePolicies(current).defaults.getPublicKey).toBe('allow')
  })
})

describe('buildTrustedSiteRule', () => {
  it('allows supported methods while preserving protected kind prompts', () => {
    expect(buildTrustedSiteRule()).toMatchObject({
      getPublicKey: 'allow',
      getRelays: 'allow',
      signEvent: 'allow',
      'nip04.encrypt': 'allow',
      'nip04.decrypt': 'allow',
      'nip44.encrypt': 'allow',
      'nip44.decrypt': 'allow',
      kindRules: DEFAULT_POLICIES.kindRules,
    })
  })

  it('preserves existing site-specific kind overrides', () => {
    expect(buildTrustedSiteRule({ kindRules: { '0': 'allow' } }).kindRules).toMatchObject({
      ...DEFAULT_POLICIES.kindRules,
      '0': 'allow',
    })
  })
})
