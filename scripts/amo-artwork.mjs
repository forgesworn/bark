// Refresh AMO listing artwork from a published release tag. Dry-run by default.
import { execFileSync } from 'node:child_process'
import { amoJwt, normaliseVersion, requireEnv } from './store-lib.mjs'
const { tag } = normaliseVersion(process.argv[2] || '')
const apply = process.argv.includes('--apply')
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
    const response = await fetch(api + suffix, {
      method, headers: { authorization: `JWT ${amoJwt(issuer, secret)}` }, body,
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`AMO ${method} ${suffix}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const before = await request()
  const imageForm = ({ name, bytes }, field) => {
    const form = new FormData()
    form.set(field, new Blob([bytes], { type: 'image/png' }), name)
    return form
  }
  await request('', 'PATCH', imageForm(images[0], 'icon'))
  console.log('AMO icon uploaded')
  const created = []
  // Preserve all old previews until every replacement has been uploaded and read back.
  for (const [position, image] of images.slice(1).entries()) {
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
  for (const preview of before.previews) await request(`previews/${preview.id}/`, 'DELETE')
  const final = await request()
  if (final.previews.length !== 5 || !created.every(id => final.previews.some(preview => preview.id === id))) {
    throw new Error('AMO preview verification failed')
  }
  console.log(`${tag}: AMO listing icon and five previews updated and verified`)
}
