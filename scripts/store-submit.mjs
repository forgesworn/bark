#!/usr/bin/env node
// One-command local store submission for a released version:
//
//   npm run store:submit -- v1.3.7 [--no-chrome] [--no-firefox] [--no-publish]
//
// Downloads the release zips (the exact CI-built assets), cuts the AMO source
// zip and the release-notes changelog FROM THE TAG (the working tree may be
// ahead), and runs the two submit scripts. Credentials come from the
// environment, or from an env file kept outside this public repo -
// ~/ops/bark-store.env by default, overridable with BARK_STORE_ENV. See
// docs/store-submit.md for minting each credential.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normaliseVersion } from './store-lib.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const versionInput = args.find(a => !a.startsWith('--'))
if (!versionInput) {
  console.error('Usage: npm run store:submit -- vX.Y.Z [--no-chrome] [--no-firefox] [--no-publish]')
  process.exit(2)
}
const { tag } = normaliseVersion(versionInput)
const chrome = !args.includes('--no-chrome')
const firefox = !args.includes('--no-firefox')

// Env file: KEY=VALUE lines, no quoting cleverness. Real env always wins.
const envFile = process.env.BARK_STORE_ENV || join(homedir(), 'ops', 'bark-store.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2]
  }
  console.log(`credentials loaded from ${envFile}`)
}

function run(title, command, cmdArgs, options = {}) {
  console.log(`\n== ${title}`)
  const result = spawnSync(command, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...options })
  if (result.status !== 0) {
    console.error(`${title} failed - stopping here.`)
    process.exit(result.status ?? 1)
  }
}

const work = mkdtempSync(join(tmpdir(), 'bark-store-'))
const cwsZip = join(work, `bark-${tag}.zip`)
const amoZip = join(work, `bark-firefox-${tag}.zip`)
const sourceZip = join(work, `bark-${tag}-source.zip`)
const changelogAtTag = join(work, 'CHANGELOG.md')

run('download release assets', 'gh', [
  'release', 'download', tag,
  '--pattern', `bark-${tag}.zip`,
  '--pattern', `bark-firefox-${tag}.zip`,
  '--dir', work,
])
run('cut the source zip from the tag', 'git', ['archive', '--format=zip', '-o', sourceZip, tag])

// Release notes must describe the tagged version even when the working tree
// has moved on, so read the changelog out of the tag itself.
const show = spawnSync('git', ['show', `${tag}:CHANGELOG.md`], { cwd: ROOT, encoding: 'utf8' })
if (show.status !== 0) {
  console.error(`could not read CHANGELOG.md from ${tag}`)
  process.exit(1)
}
writeFileSync(changelogAtTag, show.stdout)

if (chrome) {
  run('submit to the Chrome Web Store', process.execPath, [
    join(ROOT, 'scripts/cws-submit.mjs'),
    '--zip', cwsZip,
    ...(args.includes('--no-publish') ? ['--no-publish'] : []),
  ])
}
if (firefox) {
  run('submit to AMO', process.execPath, [
    join(ROOT, 'scripts/amo-submit.mjs'),
    '--zip', amoZip,
    '--source', sourceZip,
    '--version', tag,
    '--changelog', changelogAtTag,
  ])
}

console.log(`\n${tag} submitted${chrome && firefox ? ' to both stores' : chrome ? ' to CWS' : ' to AMO'}. Review queues still apply.`)
