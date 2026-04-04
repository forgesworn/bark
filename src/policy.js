/**
 * Policy evaluation engine for Bark signing requests.
 *
 * Evaluation order (highest priority first):
 *   1. Site-specific kindRule  — siteRules[origin].kindRules[kind]
 *   2. Site-specific method default — siteRules[origin][method]
 *   3. Global kindRule — kindRules[kind]
 *   4. Global method default — defaults[method]
 *   5. Fallback — 'allow'
 */

/** Valid policy action values. */
const VALID_ACTIONS = new Set(['allow', 'ask', 'deny'])

/**
 * Default policy set.
 * All standard NIP-07/NIP-44 methods are allowed by default; sensitive
 * event kinds (profile, contact list, relay list) require user confirmation.
 */
export const DEFAULT_POLICIES = {
  defaults: {
    getPublicKey: 'allow',
    signEvent: 'allow',
    'nip44.encrypt': 'allow',
    'nip44.decrypt': 'allow',
  },
  kindRules: {
    '0': 'ask',     // profile metadata
    '3': 'ask',     // contact list
    '10002': 'ask', // relay list
  },
  siteRules: {},
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
  const { defaults = {}, kindRules = {}, siteRules = {} } = policies

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

    // 2. Site-specific method default
    if (site) {
      const action = validAction(site[method])
      if (action !== null) return action
    }
  }

  // 3. Global kindRule
  if (kindKey !== null) {
    const action = validAction(kindRules[kindKey])
    if (action !== null) return action
  }

  // 4. Global method default
  const action = validAction(defaults[method])
  if (action !== null) return action

  // 5. Fallback
  return 'allow'
}
