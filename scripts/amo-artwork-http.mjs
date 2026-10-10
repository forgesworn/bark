// AMO listing edits share a low write-rate allowance. A 429 rejects the request;
// only that explicit response can be retried. Never replay network failures.
export function createPacedAmoFetch({ fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let previousWrite = null
  return async (url, options) => {
    const makeOptions = typeof options === 'function' ? options : () => options
    const write = makeOptions().method !== 'GET'
    if (write && previousWrite !== null) await sleep(Math.max(0, 30_000 - (now() - previousWrite)))
    for (let attempt = 0; ; attempt++) {
      if (write) previousWrite = now()
      const response = await fetchImpl(url, { ...makeOptions(), signal: AbortSignal.timeout(60_000) })
      if (response.status !== 429 || attempt === 3) return response
      const header = response.headers.get('retry-after')
      const seconds = Number(header)
      const delay = header && Number.isFinite(seconds)
        ? seconds * 1000
        : header ? Date.parse(header) - now() : 60_000
      if (!Number.isFinite(delay) || delay > 3_600_000) return response
      const wait = Math.max(30_000, delay)
      console.log(`AMO rate limit: waiting ${Math.ceil(wait / 1000)} seconds before retrying the rejected request`)
      await response.body?.cancel()
      await sleep(wait)
    }
  }
}
export const pacedAmoFetch = createPacedAmoFetch()
