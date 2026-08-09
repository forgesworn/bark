#!/usr/bin/env node
// One-time helper: mint the Chrome Web Store refresh token for CI.
//
//   node scripts/cws-mint-token.mjs <client_id> <client_secret>
//
// Opens the Google consent URL, catches the redirect on localhost, exchanges
// the code, and prints the refresh token to store as the CWS_REFRESH_TOKEN
// secret. Run it on any machine with a browser logged into the developer
// account. The OAuth app must be in "production" publishing status or Google
// expires the refresh token after seven days.

import { createServer } from 'node:http'

const [clientId, clientSecret] = process.argv.slice(2)
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/cws-mint-token.mjs <client_id> <client_secret>')
  process.exit(2)
}

const port = 8123
const redirect = `http://localhost:${port}/`
const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/chromewebstore',
  access_type: 'offline',
  prompt: 'consent',
}).toString()

const server = createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code')
  if (!code) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('Token minted - back to the terminal.')
  server.close()
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
    }),
  })
  const token = await tokenRes.json()
  if (!token.refresh_token) {
    console.error(`No refresh token in the response:\n${JSON.stringify(token, null, 2)}`)
    process.exit(1)
  }
  console.log('\nCWS_REFRESH_TOKEN:\n')
  console.log(token.refresh_token)
  console.log('\nStore it:  gh secret set CWS_REFRESH_TOKEN --repo forgesworn/bark')
})

server.listen(port, () => {
  console.log('Open this URL in a browser logged into the Chrome Web Store developer account:\n')
  console.log(consent.toString())
})
