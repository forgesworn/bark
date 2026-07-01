import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { pairHeartwoodHttpAddress } from '../src/background.js'

const masterPubkey = 'a'.repeat(64)
const socialPubkey = 'b'.repeat(64)
const masterUri = `bunker://${masterPubkey}?relay=wss://relay.example.com`
const socialUri = `bunker://${socialPubkey}?relay=wss://relay.example.com&secret=social-slot`

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function withHttpServer(handler, fn) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      sendJson(res, 500, { error: err.message })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    return await fn(baseUrl)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }
}

describe('Heartwood/bridge HTTP pairing contract', () => {
  it('imports per-identity bunker URIs from /api/identities after pairing', async () => {
    const pairRequests = []

    await withHttpServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair') {
        pairRequests.push(JSON.parse(await readBody(req)))
        sendJson(res, 200, {
          instance: 'heartwood',
          npub: 'npub1master',
          bunkerUri: masterUri,
        })
        return
      }

      if (req.method === 'GET' && req.url === '/api/identities') {
        sendJson(res, 200, {
          identities: [
            { label: 'master', pubkey: masterPubkey, npub: 'npub1master', uri: masterUri },
            { label: 'social', pubkey: socialPubkey, npub: 'npub1social', uri: socialUri },
          ],
        })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    }, async (baseUrl) => {
      const result = await pairHeartwoodHttpAddress(baseUrl, {
        instances: [],
        activeInstanceId: null,
      })

      expect(pairRequests).toHaveLength(1)
      expect(pairRequests[0].name).toBe('bark')
      expect(pairRequests[0].pubkey).toMatch(/^[0-9a-f]{64}$/)

      expect(result.imported).toBe(2)
      expect(result.activeInstanceId).toBe('heartwood-aaaaaaaa')
      expect(result.instances).toHaveLength(2)
      expect(result.instances[0]).toMatchObject({
        id: 'heartwood-aaaaaaaa',
        name: 'heartwood',
        address: baseUrl,
        bunkerUri: masterUri,
        npub: 'npub1master',
        isHeartwood: true,
        heartwoodBaseName: 'heartwood',
        heartwoodIdentityLabel: 'master',
        heartwoodIdentityPubkey: masterPubkey,
      })
      expect(result.instances[1]).toMatchObject({
        id: 'heartwood:social-bbbbbbbb',
        name: 'heartwood:social',
        address: baseUrl,
        bunkerUri: socialUri,
        npub: 'npub1social',
        isHeartwood: true,
        heartwoodBaseName: 'heartwood',
        heartwoodIdentityLabel: 'social',
        heartwoodIdentityPubkey: socialPubkey,
      })
      expect(result.instances[0].clientSecret).toMatch(/^[0-9a-f]{64}$/)
      expect(result.instances[1].clientSecret).toBe(result.instances[0].clientSecret)
    })
  })

  it('falls back to the master bunker URI when /api/identities is unavailable', async () => {
    await withHttpServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair') {
        await readBody(req)
        sendJson(res, 200, {
          instance: 'bridge host',
          npub: 'npub1master',
          bunkerUri: masterUri,
        })
        return
      }

      if (req.method === 'GET' && req.url === '/api/identities') {
        sendJson(res, 404, { error: 'not available in bridge mode' })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    }, async (baseUrl) => {
      const result = await pairHeartwoodHttpAddress(baseUrl, {
        instances: [],
        activeInstanceId: null,
      })

      expect(result.imported).toBe(0)
      expect(result.activeInstanceId).toBe('bridge-host-aaaaaaaa')
      expect(result.instances).toHaveLength(1)
      expect(result.instances[0]).toMatchObject({
        id: 'bridge-host-aaaaaaaa',
        name: 'bridge-host',
        address: baseUrl,
        bunkerUri: masterUri,
        npub: 'npub1master',
        isHeartwood: true,
        heartwoodBaseName: 'bridge-host',
        heartwoodIdentityLabel: 'master',
        heartwoodIdentityPubkey: masterPubkey,
      })
    })
  })

  it('rejects a pairing response with an invalid bunker URI', async () => {
    await withHttpServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair') {
        await readBody(req)
        sendJson(res, 200, {
          instance: 'heartwood',
          bunkerUri: 'https://not-a-bunker.example',
        })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    }, async (baseUrl) => {
      await expect(pairHeartwoodHttpAddress(baseUrl, {
        instances: [],
        activeInstanceId: null,
      })).rejects.toThrow('Server returned an invalid bunker URI.')
    })
  })
})
