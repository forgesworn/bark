// Dependency-injected CWS v2 client, tested without credentials or store writes.
const API = 'https://chromewebstore.googleapis.com'
const ACCEPTED = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'])

export async function submitChrome({ publisherId, extensionId, accessToken, version, zip, publish = true }, {
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxPolls = 36,
} = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(publisherId ?? '') || !/^[a-p]{32}$/.test(extensionId ?? '')) {
    throw new Error('Invalid Chrome publisher or extension ID')
  }
  if (!accessToken || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !zip?.length) {
    throw new Error('Chrome requires an access token, release version and non-empty package')
  }
  const name = `publishers/${publisherId}/items/${extensionId}`
  async function request(step, path, options = {}) {
    let response
    try {
      response = await fetchImpl(`${API}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${accessToken}`, ...options.headers },
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      })
    } catch {
      // A mutation may have succeeded even if its reply was lost. Never replay it.
      throw new Error(`Chrome ${step}: network error or timeout; check store status before retrying`)
    }
    if (!response.ok) throw new Error(`Chrome ${step}: HTTP ${response.status}; check the developer dashboard for details`)
    let data
    try { data = await response.json() } catch { throw new Error(`Chrome ${step}: invalid JSON response`) }
    if (!data || data.name !== name || data.itemId !== extensionId) {
      throw new Error(`Chrome ${step}: response identifies a different item`)
    }
    return data
  }
  const statusPath = `/v2/${name}:fetchStatus`
  const before = await request('status', statusPath)
  if (before.takenDown || before.warned) throw new Error('Chrome listing needs attention in the developer dashboard')
  for (const revision of [before.submittedItemRevisionStatus, before.publishedItemRevisionStatus]) {
    const versions = revision?.distributionChannels?.map(channel => channel.crxVersion) ?? []
    if (versions.length && versions.every(value => value === version) && ACCEPTED.has(revision.state)) {
      return { state: revision.state, alreadySubmitted: true }
    }
  }
  if (ACCEPTED.has(before.submittedItemRevisionStatus?.state)) {
    throw new Error('Another Chrome revision is submitted; resolve it in the dashboard before uploading')
  }
  if (before.lastAsyncUploadState === 'IN_PROGRESS') throw new Error('A Chrome upload is already in progress; retry after it finishes')

  const upload = await request('upload', `/upload/v2/${name}:upload`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip,
  })
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error('Chrome uploaded version does not match the release')
  let state = upload.uploadState
  for (let poll = 0; state === 'IN_PROGRESS' && poll < maxPolls; poll++) {
    await sleep(5_000)
    state = (await request('upload status', statusPath)).lastAsyncUploadState
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(state === 'IN_PROGRESS'
      ? 'Chrome upload validation timed out; nothing submitted for review'
      : 'Chrome upload validation failed or returned an unknown state; nothing submitted for review')
  }
  if (!publish) return { state: 'UPLOADED', alreadySubmitted: false }
  const result = await request('publish', `/v2/${name}:publish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }),
  })
  if (!ACCEPTED.has(result.state)) throw new Error('Chrome did not confirm submission; check the developer dashboard')
  return { state: result.state, alreadySubmitted: false }
}
