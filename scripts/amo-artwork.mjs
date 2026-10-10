// Refresh AMO listing artwork from a published release tag. Dry-run by default.
import { execFileSync } from 'node:child_process'
import { amoJwt, normaliseVersion, requireEnv } from './store-lib.mjs'
import { pacedAmoFetch } from './amo-artwork-http.mjs'
const { tag } = normaliseVersion(process.argv[2] || '')
const apply = process.argv.includes('--apply')
const resumeIndex = process.argv.indexOf('--resume-previews')
const resumeInput = resumeIndex === -1 ? '' : process.argv[resumeIndex + 1]
if (resumeInput && !/^\d+(,\d+){4}$/.test(resumeInput)) throw new Error('Resume requires five comma-separated preview IDs; use 0 for missing images')
const resumed = resumeInput ? resumeInput.split(',').map(Number) : [0,0,0,0,0]
if (resumed.some(id => !Number.isSafeInteger(id)) || new Set(resumed.filter(Boolean)).size !== resumed.filter(Boolean).length) throw new Error('Invalid or repeated resume preview IDs')
execFileSync('git', ['merge-base', '--is-ancestor', tag, 'origin/main'])
const release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'isDraft,isPrerelease'], { encoding: 'utf8' }))
if (release.isDraft || release.isPrerelease) throw new Error('Artwork requires a published stable release')
const tagged = (name) => execFileSync('git', ['show', `${tag}:docs/store-assets/${name}`])
const files = ['store-icon-128.png', '01-connected.png', '02-approval.png', '03-policies.png', '04-qr-pairing.png', '05-personas.png']
const images = files.map((name) => ({ name, bytes: tagged(name) }))
for (const { name, bytes } of images) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Invalid PNG: ${name}`)
}
console.log(`${tag}: ${images.length} tagged PNGs verified; ${apply ? 'updating AMO' : 'dry-run, no writes'}`)
if (apply) {
  const issuer = requireEnv('AMO_JWT_ISSUER'), secret = requireEnv('AMO_JWT_SECRET')
  const api = 'https://addons.mozilla.org/api/v5/addons/addon/bark-nostr/'
  async function request(suffix = '', method = 'GET', body) {
    const response = await pacedAmoFetch(api + suffix, () => ({
      method, headers: { authorization: `JWT ${amoJwt(issuer, secret)}` }, body,
    }))
    if (!response.ok) throw new Error(`AMO ${method} ${suffix}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const before = await request()
  const imageForm = ({ name, bytes }, field) => {
    const form = new FormData()
    form.set(field, new Blob([bytes], { type: 'image/png' }), name)
    return form
  }
  if (!resumed.some(Boolean)) {
    await request('', 'PATCH', imageForm(images[0], 'icon'))
    console.log('AMO icon uploaded')
  }
  for (const [position, id] of resumed.entries()) {
    if (id && !before.previews.some(preview => preview.id === id && preview.position === position)) throw new Error('Resume preview does not belong to the expected position; no preview writes made')
  }
  const created = []
  // Preserve all old previews until every replacement has been uploaded and read back.
  for (const [position, image] of images.slice(1).entries()) {
    if (resumed[position]) { created.push(resumed[position]); console.log(`AMO preview ${position + 1} reused: ${resumed[position]}`); continue }
    const form = imageForm(image, 'image')
    form.set('position', String(position))
    const preview = await request('previews/', 'POST', form)
    if (!Number.isInteger(preview.id)) throw new Error('AMO did not return a preview ID; old previews preserved')
    created.push(preview.id)
    console.log(`AMO preview ${position + 1} uploaded: ${preview.id}`)
  }
  const refreshed = await request()
  if (!created.every(id => refreshed.previews.some(preview => preview.id === id))) {
    throw new Error('Replacement previews not all visible; old previews preserved')
  }
  for (const preview of before.previews) {
    if (!created.includes(preview.id)) await request(`previews/${preview.id}/`, 'DELETE')
  }
  const final = await request()
  if (final.previews.length !== 5 || !created.every(id => final.previews.some(preview => preview.id === id))) {
    throw new Error('AMO preview verification failed')
  }
  console.log(`${tag}: AMO listing icon and five previews updated and verified`)
}
