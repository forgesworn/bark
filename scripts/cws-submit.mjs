#!/usr/bin/env node
// Chrome Web Store v2. Tokens stay in memory; never print provider responses.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { requireEnv, normaliseVersion } from './store-lib.mjs'
import { submitChrome } from './cws-lib.mjs'

const args = process.argv.slice(2)
const zipIndex = args.indexOf('--zip')
const versionIndex = args.indexOf('--version')
if (zipIndex < 0 || !args[zipIndex + 1] || versionIndex < 0 || !args[versionIndex + 1]) {
  console.error('Usage: node scripts/cws-submit.mjs --zip <file> --version <X.Y.Z> [--no-publish]')
  process.exit(2)
}

try {
  const { version } = normaliseVersion(args[versionIndex + 1])
  const zipPath = args[zipIndex + 1]
  const manifest = spawnSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' })
  if (manifest.status !== 0 || JSON.parse(manifest.stdout).version !== version) {
    throw new Error('Package manifest does not match the requested release version')
  }
  const result = await submitChrome({
    publisherId: requireEnv('CWS_PUBLISHER_ID'),
    extensionId: requireEnv('CWS_EXTENSION_ID'),
    accessToken: requireEnv('CWS_ACCESS_TOKEN'),
    version,
    zip: readFileSync(zipPath),
    publish: !args.includes('--no-publish'),
  })
  console.log(`Chrome ${version}: ${result.state}${result.alreadySubmitted ? ' (already submitted; no upload)' : ''}`)
  if (result.state === 'PENDING_REVIEW') console.log('Submitted for review; Google approval is still required.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
