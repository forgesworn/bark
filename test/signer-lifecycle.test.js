import { describe, it, expect } from 'vitest'
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { disposeSigner, trackSignerRequests } from '../src/signer-lifecycle.js'
import { withDeterministicNip46Signer, CLIENT_SECRET_HEX } from '../e2e/nip46-test-helpers.js'

describe('real nostr-tools resource lifecycle', () => {
  it('closes every socket over repeated connections and rejects an outstanding request', async () => {
    await withDeterministicNip46Signer(async (remote) => {
      const bp = await parseBunkerInput(remote.bunkerUri)
      for (let i = 0; i < 4; i++) {
        const bunker = BunkerSigner.fromBunker(Uint8Array.from(Buffer.from(CLIENT_SECRET_HEX, 'hex')), bp)
        trackSignerRequests(bunker)
        try {
          await bunker.connect()
          for (let n = 0; n < 12; n++) await bunker.ping()
          expect(Object.keys(bunker.waitingForAuth)).toHaveLength(0)
          expect(Object.keys(bunker.listeners)).toHaveLength(0)
          expect(await bunker.getPublicKey()).toBe(remote.pubkey)
          // Silence after a real successful connection models a lost signer.
          const handler = remote.handleRequest
          remote.handleRequest = () => ({})
          const pending = bunker.sendRequest('ping', [])
          const rejected = expect(pending).rejects.toThrow('connection changed')
          disposeSigner(bunker)
          disposeSigner(bunker) // cleanup is idempotent
          await rejected
          await expect.poll(() => remote.connections.size).toBe(0)
          expect(Object.keys(bunker.listeners)).toHaveLength(0)
          expect(Object.keys(bunker.waitingForAuth)).toHaveLength(0)
          remote.handleRequest = handler
        } finally {
          disposeSigner(bunker)
        }
      }
    })
  })
})
