import { describe, it, expect, vi } from 'vitest'
import { submitChrome } from '../scripts/cws-lib.mjs'

const itemId = 'gdpcaoemjjglcebpjjljmhndbpeckpln'
const name = `publishers/test-publisher/items/${itemId}`
const options = { publisherId: 'test-publisher', extensionId: itemId, accessToken: 'secret-token', version: '1.3.14', zip: Buffer.from('zip') }
const uploaded = { uploadState: 'SUCCEEDED', crxVersion: '1.3.14' }
const published = { state: 'PENDING_REVIEW' }
const revision = (version, state = 'PENDING_REVIEW') => ({ state, distributionChannels: [{ crxVersion: version }] })
function harness(responses) {
  const fetchImpl = vi.fn(async () => {
    const result = responses.shift()
    if (result instanceof Error) throw result
    if (result instanceof Response) return result
    if (result === undefined) throw new Error('Unexpected request')
    return Response.json({ name, itemId, ...result })
  })
  return { fetchImpl, sleep: vi.fn(async () => {}), maxPolls: 3 }
}

describe('Chrome v2 submission', () => {
  it('uploads before publishing with review and warning checks enabled', async () => {
    const deps = harness([{}, uploaded, published])
    await expect(submitChrome(options, deps)).resolves.toEqual({ state: 'PENDING_REVIEW', alreadySubmitted: false })
    const calls = deps.fetchImpl.mock.calls
    expect(calls.map(([url]) => url.split(':').at(-1))).toEqual(['fetchStatus', 'upload', 'publish'])
    expect(calls[1][0]).toContain('/upload/v2/publishers/')
    expect(calls[1][1].method).toBe('POST')
    expect(calls[1][1].body).toBe(options.zip)
    expect(JSON.parse(calls[2][1].body)).toEqual({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true })
    expect(calls.every(([, request]) => request.redirect === 'error' && request.signal instanceof AbortSignal)).toBe(true)
  })
  it('waits for asynchronous validation before publishing', async () => {
    const deps = harness([{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }, published])
    await submitChrome(options, deps)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.fetchImpl.mock.calls.at(-1)[0]).toMatch(/:publish$/)
  })
  it.each(['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', undefined])('never publishes upload state %s', async state => {
    const deps = harness([{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: state }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/validation failed/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('bounds polling and does not submit after timeout', async () => {
    const deps = harness([{}, { uploadState: 'IN_PROGRESS' }, ...Array(3).fill({ lastAsyncUploadState: 'IN_PROGRESS' })])
    await expect(submitChrome(options, deps)).rejects.toThrow(/timed out/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(5)
  })
  it.each(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'])('does not re-upload the same version in state %s', async state => {
    const deps = harness([{ submittedItemRevisionStatus: revision(options.version, state) }])
    await expect(submitChrome(options, deps)).resolves.toEqual({ state, alreadySubmitted: true })
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('recognises the publicly published version', async () => {
    const deps = harness([{ publishedItemRevisionStatus: revision(options.version, 'PUBLISHED') }])
    expect((await submitChrome(options, deps)).alreadySubmitted).toBe(true)
  })
  it('does not replace another pending revision', async () => {
    const deps = harness([{ submittedItemRevisionStatus: revision('1.3.13') }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/Another Chrome revision/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('does not interfere with another asynchronous upload', async () => {
    const deps = harness([{ lastAsyncUploadState: 'IN_PROGRESS' }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/already in progress/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('supports upload-only', async () => {
    const deps = harness([{}, uploaded])
    expect((await submitChrome({ ...options, publish: false }, deps)).state).toBe('UPLOADED')
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('rejects the wrong uploaded version before publish', async () => {
    const deps = harness([{}, { ...uploaded, crxVersion: '1.3.13' }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/does not match/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('rejects wrong item responses', async () => {
    const deps = harness([{ itemId: 'a'.repeat(32) }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/different item/)
  })
  it.each(['REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED'])('does not report %s as success', async state => {
    await expect(submitChrome(options, harness([{}, uploaded, { state }]))).rejects.toThrow(/did not confirm/)
  })
  it.each(['takenDown', 'warned'])('stops on listing flag %s', async flag => {
    const deps = harness([{ [flag]: true }])
    await expect(submitChrome(options, deps)).rejects.toThrow(/needs attention/)
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('does not log response bodies or replay a rejected upload', async () => {
    const deps = harness([{}, new Response('secret-token', { status: 403 })])
    await expect(submitChrome(options, deps)).rejects.toThrow('Chrome upload: HTTP 403; check the developer dashboard for details')
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('does not replay an upload whose response was lost', async () => {
    const deps = harness([{}, new Error('secret-token')])
    await expect(submitChrome(options, deps)).rejects.toThrow('Chrome upload: network error or timeout; check store status before retrying')
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid IDs before sending the token', async () => {
    const deps = harness([])
    await expect(submitChrome({ ...options, publisherId: '../bad' }, deps)).rejects.toThrow(/Invalid/)
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })
})
