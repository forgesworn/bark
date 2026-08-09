#!/usr/bin/env node
// Submit a built zip to the Chrome Web Store: upload the package onto the
// existing listing, then (unless --no-publish) submit it for review.
//
//   CWS_EXTENSION_ID=... CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... \
//   CWS_REFRESH_TOKEN=... node scripts/cws-submit.mjs --zip bark-v1.3.7.zip
//
// The API cannot create a listing - only update one - and it acts as the
// developer account behind the OAuth refresh token (service accounts are not
// supported). Minting the token once is a human job: docs/store-submit.md.

import { readFileSync } from 'node:fs'
import { requireEnv } from './store-lib.mjs'

const args = process.argv.slice(2)
const zipPath = args[args.indexOf('--zip') + 1]
const publish = !args.includes('--no-publish')
if (!zipPath || args.indexOf('--zip') === -1) {
  console.error('Usage: node scripts/cws-submit.mjs --zip <file> [--no-publish]')
  process.exit(2)
}

const extensionId = requireEnv('CWS_EXTENSION_ID')
const clientId = requireEnv('CWS_CLIENT_ID')
const clientSecret = requireEnv('CWS_CLIENT_SECRET')
const refreshToken = requireEnv('CWS_REFRESH_TOKEN')

async function fail(step, response) {
  const body = await response.text().catch(() => '(no body)')
  console.error(`${step} failed: HTTP ${response.status}\n${body}`)
  process.exit(1)
}

// 1. Refresh token -> access token.
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }),
})
if (!tokenRes.ok) await fail('token refresh', tokenRes)
const { access_token: accessToken } = await tokenRes.json()

// 2. Upload the package onto the listing.
const uploadRes = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${extensionId}`,
  {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'x-goog-api-version': '2' },
    body: readFileSync(zipPath),
  },
)
if (!uploadRes.ok) await fail('upload', uploadRes)
const upload = await uploadRes.json()
if (upload.uploadState !== 'SUCCESS' && upload.uploadState !== 'IN_PROGRESS') {
  console.error(`upload rejected: ${JSON.stringify(upload.itemError || upload, null, 2)}`)
  process.exit(1)
}
console.log(`uploaded ${zipPath} (${upload.uploadState})`)

// 3. Submit for review (publishes automatically once review passes).
if (publish) {
  const publishRes = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${extensionId}/publish?publishTarget=default`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'x-goog-api-version': '2' } },
  )
  if (!publishRes.ok) await fail('publish', publishRes)
  const result = await publishRes.json()
  console.log(`submitted for review: ${JSON.stringify(result.status || result)}`)
} else {
  console.log('uploaded only (--no-publish): submit from the dashboard when ready')
}
