// Relays can refuse a request outright ("OK false": banned, rate-limited,
// auth-required). nostr-tools only needs one relay to accept the publish, so a
// refusal from the relay the signer is actually listening on is lost, and the
// user sees a bare timeout 45 s later. This keeps the latest refusal per relay
// for a short while, so a timeout can say which relay turned the request away
// and why.

/** How long a refusal stays relevant to a timeout (ms). */
export const REFUSAL_WINDOW_MS = 120_000

/** Prefix for the explained-timeout message; listed as safe in sanitiseError. */
export const REFUSAL_MESSAGE_PREFIX = 'Signer relay refused the request'

const MAX_REASON_CHARS = 100

/** Host of a relay URL, without scheme, port or path. */
export function relayHost(url) {
  const raw = String(url || '').trim()
  try {
    return new URL(raw).hostname || raw
  } catch {
    return raw.replace(/^wss?:\/\//i, '').split(/[/:?#]/)[0]
  }
}

/**
 * Relay text is untrusted: keep it short, printable and free of anything that
 * looks like a path, so it is safe to show in the page and the popup.
 */
export function cleanRelayReason(reason) {
  const text = typeof reason === 'string' ? reason : (reason?.message || String(reason ?? ''))
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.length > MAX_REASON_CHARS ? `${cleaned.slice(0, MAX_REASON_CHARS - 1)}…` : cleaned
}

/** True when the reason reads like the relay blocking this network address. */
export function looksLikeAddressBlock(reason) {
  return /\b(banned|blocked|rate[- ]?limit|too many)\b/i.test(String(reason || ''))
}

export function createRelayRefusals({ now = () => Date.now(), windowMs = REFUSAL_WINDOW_MS } = {}) {
  const byHost = new Map()
  return {
    /** Record a relay turning a publish away. */
    refused(url, reason) {
      const host = relayHost(url)
      const text = cleanRelayReason(reason)
      if (!host || !text) return
      byHost.set(host, { host, reason: text, at: now() })
    },
    /** A relay accepted a publish: forget its earlier refusal. */
    accepted(url) {
      byHost.delete(relayHost(url))
    },
    /** Refusals newer than the window, for the given relays (all if none given). */
    recent(urls) {
      const wanted = Array.isArray(urls) && urls.length ? new Set(urls.map(relayHost)) : null
      const cutoff = now() - windowMs
      const out = []
      for (const entry of byHost.values()) {
        if (entry.at < cutoff) { byHost.delete(entry.host); continue }
        if (!wanted || wanted.has(entry.host)) out.push(entry)
      }
      return out
    },
    clear() { byHost.clear() },
  }
}

/**
 * The message for a request that timed out or failed while one or more relays
 * were refusing it, or '' when nothing was refused.
 */
export function describeRelayRefusals(refusals) {
  if (!Array.isArray(refusals) || refusals.length === 0) return ''
  const parts = refusals.map((r) => `${r.host} said "${r.reason}"`)
  const blocked = refusals.some((r) => looksLikeAddressBlock(r.reason))
  const advice = blocked
    ? 'Your network address may be blocked there. Try another network or VPN server.'
    : 'Your signer may not hear requests until that relay accepts them.'
  return `${REFUSAL_MESSAGE_PREFIX}: ${parts.join('; ')}. ${advice}`
}
