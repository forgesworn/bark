import { test, expect } from './extension.fixture.js'
import {
  readExtensionStorage,
  runtimeMessage,
  withDeterministicNip46Signer,
} from './nip46-test-helpers.js'

test('pairs via client-initiated nostrconnect and signs through the new instance', async ({ context, extensionId }) => {
  test.setTimeout(120_000)

  await withDeterministicNip46Signer(async (signer) => {
    try {
      const start = await runtimeMessage(context, extensionId, {
        type: 'bark-nostrconnect-start',
        relays: signer.relayUrl,
      })
      expect(start).toMatchObject({ ok: true })
      expect(start.uri).toMatch(/^nostrconnect:\/\/[0-9a-f]{64}\?/)
      expect(start.uri).toContain(encodeURIComponent(signer.relayUrl))

      // Re-publish the ack on each poll — the extension's relay subscription
      // may not be registered yet when the first ack goes out.
      await expect.poll(async () => {
        signer.acceptNostrConnect(start.uri)
        const status = await runtimeMessage(context, extensionId, {
          type: 'bark-nostrconnect-status',
        })
        return status?.status
      }, { timeout: 30_000, intervals: [1_000] }).toBe('connected')

      const stored = await readExtensionStorage(context, extensionId, [
        'instances',
        'activeInstanceId',
      ])
      expect(stored.instances).toHaveLength(1)
      expect(stored.instances[0].name).toBe('nostrconnect')
      expect(stored.instances[0].bunkerUri).toContain(signer.pubkey)
      expect(stored.activeInstanceId).toBe(stored.instances[0].id)

      // Sign through the newly adopted connection via the signer health check.
      const primed = await runtimeMessage(context, extensionId, {
        type: 'bark-prime-signer',
      }, 35_000)
      expect(primed).toMatchObject({ ok: true, pubkey: signer.pubkey })
      expect(primed.id).toMatch(/^[0-9a-f]{64}$/)

      expect(signer.methods).toContain('sign_event')

      // The deterministic signer rejects heartwood probes as unsupported, so
      // the adopted instance must not be misdetected as Heartwood.
      const { isHeartwood } = await readExtensionStorage(context, extensionId, ['isHeartwood'])
      expect(isHeartwood).toBe(false)
    } finally {
      await Promise.race([
        runtimeMessage(context, extensionId, { type: 'bark-reset' }, 5_000),
        new Promise((resolve) => setTimeout(resolve, 7_000)),
      ]).catch(() => {})
    }
  })
})
