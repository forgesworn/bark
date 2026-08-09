#!/usr/bin/env node
// Submit a built zip to AMO (addons.mozilla.org): upload the package, wait for
// validation, create a listed version with release notes from CHANGELOG.md,
// then attach the source zip AMO requires for bundled code.
//
//   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/amo-submit.mjs \
//     --zip bark-firefox-v1.3.7.zip --source bark-v1.3.7-source.zip --version v1.3.7
//
// The add-on must already exist on AMO (the API updates listings, it does not
// create them). Auth is a five-minute JWT minted per request from long-lived
// API credentials: docs/store-submit.md.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { amoJwt, changelogSection, normaliseVersion, requireEnv } from './store-lib.mjs'

const args = process.argv.slice(2)
const arg = (flag) => (args.indexOf(flag) === -1 ? null : args[args.indexOf(flag) + 1])
const zipPath = arg('--zip')
const sourcePath = arg('--source')
const versionInput = arg('--version')
if (!zipPath || !sourcePath || !versionInput) {
  console.error('Usage: node scripts/amo-submit.mjs --zip <file> --source <file> --version vX.Y.Z')
  process.exit(2)
}
const { version } = normaliseVersion(versionInput)

const issuer = requireEnv('AMO_JWT_ISSUER')
const secret = requireEnv('AMO_JWT_SECRET')
const addonId = process.env.AMO_ADDON_ID || 'bark@forgesworn.local'
const API = 'https://addons.mozilla.org/api/v5'

const auth = () => ({ authorization: `JWT ${amoJwt(issuer, secret)}` })

async function fail(step, response) {
  const body = await response.text().catch(() => '(no body)')
  console.error(`${step} failed: HTTP ${response.status}\n${body}`)
  process.exit(1)
}

const releaseNotes = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
if (!releaseNotes) {
  console.error(`CHANGELOG.md has no section for ${version} - release notes are not optional here.`)
  process.exit(1)
}

// 1. Upload the package for validation.
const uploadForm = new FormData()
uploadForm.set('upload', new Blob([readFileSync(zipPath)]), basename(zipPath))
uploadForm.set('channel', 'listed')
const uploadRes = await fetch(`${API}/addons/upload/`, { method: 'POST', headers: auth(), body: uploadForm })
if (!uploadRes.ok) await fail('upload', uploadRes)
let upload = await uploadRes.json()

// 2. Poll until validation finishes; a validation failure is a hard stop.
for (let attempt = 0; !upload.processed && attempt < 30; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 5000))
  const poll = await fetch(`${API}/addons/upload/${upload.uuid}/`, { headers: auth() })
  if (!poll.ok) await fail('validation poll', poll)
  upload = await poll.json()
}
if (!upload.processed) {
  console.error('validation did not finish in time - check the AMO dashboard')
  process.exit(1)
}
if (!upload.valid) {
  console.error(`validation failed:\n${JSON.stringify(upload.validation, null, 2)}`)
  process.exit(1)
}
console.log(`validated ${zipPath}`)

// 3. Create the listed version with release notes.
const versionRes = await fetch(`${API}/addons/addon/${encodeURIComponent(addonId)}/versions/`, {
  method: 'POST',
  headers: { ...auth(), 'content-type': 'application/json' },
  body: JSON.stringify({ upload: upload.uuid, release_notes: { 'en-US': releaseNotes } }),
})
if (!versionRes.ok) await fail('version create', versionRes)
const created = await versionRes.json()
console.log(`version ${created.version || version} submitted for review`)

// 4. Attach the source zip (required for bundled code).
const sourceForm = new FormData()
sourceForm.set('source', new Blob([readFileSync(sourcePath)]), basename(sourcePath))
const sourceRes = await fetch(
  `${API}/addons/addon/${encodeURIComponent(addonId)}/versions/${created.id}/`,
  { method: 'PATCH', headers: auth(), body: sourceForm },
)
if (!sourceRes.ok) await fail('source attach', sourceRes)
console.log(`source attached: ${basename(sourcePath)}`)
