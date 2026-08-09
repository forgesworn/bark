// Pure helpers for the store submission scripts. Kept dependency-free and
// separate so the decision logic is unit-testable without touching a store.

import { createHmac, randomUUID } from 'node:crypto'

/**
 * Extract one version's section from CHANGELOG.md ("## [1.3.7] — date" up to
 * the next "## [" heading), without the heading itself. Returns '' when the
 * version has no section — the caller decides whether that is fatal.
 */
export function changelogSection(markdown, version) {
  const clean = String(version).replace(/^v/, '')
  const lines = String(markdown).split('\n')
  const start = lines.findIndex(line => line.startsWith(`## [${clean}]`))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## ['))
  return rest.slice(0, end === -1 ? rest.length : end).join('\n').trim()
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * A five-minute AMO API JWT (HS256), per addons-server's external API auth.
 * `now` is seconds; injectable for tests.
 */
export function amoJwt(issuer, secret, now = Math.floor(Date.now() / 1000), jti = randomUUID()) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: issuer, jti, iat: now, exp: now + 300 }))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/** "v1.3.7" -> { tag: "v1.3.7", version: "1.3.7" }; bare versions gain the v. */
export function normaliseVersion(input) {
  const version = String(input).trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: "${input}"`)
  return { tag: `v${version}`, version }
}

/** Read a required environment variable or die with a sentence, not a stack. */
export function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name}. See docs/store-submit.md for how to mint it.`)
    process.exit(2)
  }
  return value
}
