import { verifyEvent } from 'nostr-tools/pure'
import { test, expect } from './extension.fixture.js'
import {
  callNostr,
  runtimeMessage,
  seedDeterministicSigner,
  withDeterministicNip46Signer,
  withTestPage,
} from './nip46-test-helpers.js'

test('signs through a deterministic local NIP-46 relay signer', async ({ context, extensionId }) => {
  test.setTimeout(90_000)

  await withDeterministicNip46Signer(async (signer) => {
    await withTestPage(async (url) => {
      let page
      try {
        const origin = new URL(url).origin
        await seedDeterministicSigner({
          context,
          extensionId,
          origin,
          bunkerUri: signer.bunkerUri,
        })

        const primeResult = await runtimeMessage(context, extensionId, {
          type: 'bark-prime-signer',
        }, 35_000)
        expect(primeResult).toMatchObject({ ok: true, pubkey: signer.pubkey })

        page = await context.newPage()
        await page.goto(url)
        await expect.poll(async () => {
          return await page.evaluate(() => typeof window.nostr?.getPublicKey)
        }).toBe('function')

        const pubkey = await callNostr(page, 'getPublicKey')
        expect(pubkey).toBe(signer.pubkey)

        const relays = await callNostr(page, 'getRelays')
        expect(relays).toEqual({
          [signer.relayUrl]: { read: true, write: true },
        })

        const template = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['client', 'bark-deterministic-e2e']],
          content: 'bark deterministic local relay signer smoke',
        }
        const signed = await callNostr(page, 'signEvent', template)

        expect(signed).toMatchObject({
          kind: template.kind,
          content: template.content,
          pubkey: signer.pubkey,
        })
        expect(signed.id).toMatch(/^[0-9a-f]{64}$/)
        expect(signed.sig).toMatch(/^[0-9a-f]{128}$/)
        expect(verifyEvent(signed)).toBe(true)
        expect(signer.methods).toContain('connect')
        expect(signer.methods).toContain('heartwood_list_identities')
        expect(signer.methods).toContain('get_public_key')
        expect(signer.methods.filter((method) => method === 'sign_event').length).toBeGreaterThanOrEqual(2)
      } finally {
        if (page) {
          await Promise.race([
            page.close(),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ])
        }
        await Promise.race([
          runtimeMessage(context, extensionId, { type: 'bark-reset' }, 5_000),
          new Promise((resolve) => setTimeout(resolve, 7_000)),
        ]).catch(() => {})
      }
    }, {
      title: 'Bark Deterministic NIP-46 E2E',
      body: 'Bark Deterministic NIP-46 E2E host page',
    })
  })
})
