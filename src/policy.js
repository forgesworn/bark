/**
 * Policy evaluation engine for Bark signing requests.
 *
 * Evaluation order (highest priority first):
 *   1. Site-specific kindRule  — siteRules[origin].kindRules[kind]
 *   2. Site-specific method deny — a blocked site stays blocked
 *   3. Global kindRule — protected event kinds still ask on trusted sites
 *   4. Site-specific method default — siteRules[origin][method]
 *   5. Global method default — defaults[method]
 *   6. Fallback — 'deny'
 */

/** Valid policy action values. */
const VALID_ACTIONS = new Set(['allow', 'ask', 'deny'])

/** Current persisted policy schema version. */
export const POLICY_VERSION = 2

/**
 * Default policy set.
 * Unknown sites require explicit approval by default. Once a site is trusted,
 * global kind rules continue protecting high-impact event kinds unless the user
 * adds a site-specific kind override.
 */
export const DEFAULT_POLICIES = {
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
    '0': 'ask',     // profile metadata
    '3': 'ask',     // contact list
    '10002': 'ask', // relay list
  },
  siteRules: {},
}

/** Methods granted when the user trusts a site from the approval popup. */
export const TRUSTED_SITE_METHODS = [
  'getPublicKey',
  'getRelays',
  'signEvent',
  'nip04.encrypt',
  'nip04.decrypt',
  'nip44.encrypt',
  'nip44.decrypt',
]

/**
 * Build the site rule used by the approval popup's persistent trust action.
 * Protected global kinds are copied into the site rule so the popup can show
 * the effective policy clearly and future policy priority changes stay safe.
 */
export function buildTrustedSiteRule(existing = {}) {
  const rule = { ...existing }
  for (const method of TRUSTED_SITE_METHODS) {
    rule[method] = 'allow'
  }
  rule.kindRules = {
    ...DEFAULT_POLICIES.kindRules,
    ...(existing.kindRules || {}),
  }
  return rule
}

/**
 * Normalize stored policies to the current safer schema. Existing site and
 * kind rules are preserved, but old global defaults are replaced with the
 * current first-use approval defaults.
 */
export function normalisePolicies(policies) {
  if (!policies || policies.version !== POLICY_VERSION) {
    return {
      ...DEFAULT_POLICIES,
      kindRules: {
        ...DEFAULT_POLICIES.kindRules,
        ...(policies?.kindRules || {}),
      },
      siteRules: policies?.siteRules || {},
    }
  }

  return {
    ...DEFAULT_POLICIES,
    ...policies,
    defaults: {
      ...DEFAULT_POLICIES.defaults,
      ...(policies.defaults || {}),
    },
    kindRules: {
      ...DEFAULT_POLICIES.kindRules,
      ...(policies.kindRules || {}),
    },
    siteRules: policies.siteRules || {},
  }
}

/**
 * Evaluate the policy for a given method + params + origin combination.
 *
 * @param {object} policies  Policy set (same shape as DEFAULT_POLICIES)
 * @param {string} method    NIP-07/NIP-44 method name
 * @param {*}      params    Request params (for signEvent, an event object with .kind)
 * @param {string} [origin]  Requesting site origin (optional)
 * @returns {'allow'|'ask'|'deny'}
 */
export function evaluatePolicy(policies, method, params, origin) {
  const { defaults = {}, kindRules = {}, siteRules = {} } = normalisePolicies(policies)

  // Extract kind string for kindRules lookups (signEvent only)
  let kindKey = null
  if (method === 'signEvent' && params && typeof params === 'object') {
    const k = params.kind
    if (k !== undefined && k !== null) {
      kindKey = String(k)
    }
  }

  // Helper: validate and return an action, or null if invalid/missing
  const validAction = (value) => (VALID_ACTIONS.has(value) ? value : null)

  // 1. Site-specific kindRule
  if (origin) {
    const site = siteRules[origin]
    if (site && kindKey !== null) {
      const action = validAction(site.kindRules?.[kindKey])
      if (action !== null) return action
    }

    // 2. Site-specific method deny. A blocked site must not fall through to a
    // global "ask" for protected kinds.
    if (site) {
      const action = validAction(site[method])
      if (action === 'deny') return action
    }
  }

  // 3. Global kindRule
  if (kindKey !== null) {
    const action = validAction(kindRules[kindKey])
    if (action !== null) return action
  }

  // 4. Site-specific method default
  if (origin) {
    const site = siteRules[origin]
    if (site) {
      const action = validAction(site[method])
      if (action !== null) return action
    }
  }

  // 5. Global method default
  const action = validAction(defaults[method])
  if (action !== null) return action

  // 6. Fallback
  return 'deny'
}
