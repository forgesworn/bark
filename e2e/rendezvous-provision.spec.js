import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'
import { test, expect } from './extension.fixture.js'
import { withDeterministicNip46Signer, withTestPage, seedDeterministicSigner, runtimeMessage } from './nip46-test-helpers.js'

const target = getPublicKey(new Uint8Array(32).fill(3))
const child = getPublicKey(new Uint8Array(32).fill(4))
const makeRequest = identity => ({ v: 1, expectedPersona: identity, targetDevice: target, index: 7,
  nonce: 'AAECAwQFBgcICQoLDA0ODw', expiresAt: Math.floor(Date.now() / 1000) + 300 })
const provision = (page, request) => page.evaluate(async value => {
  try { return { ok: true, result: await window.nostr.heartwood.provisionRendezvousV1(value) } }
  catch (error) { return { ok: false, error: error.message } }
}, request)
async function begin(context, page, request) {
  const opened = context.waitForEvent('page', { predicate: candidate => candidate.url().includes('/approve.html') })
  const result = provision(page, request)
  const approval = await opened
  await approval.waitForLoadState('domcontentloaded')
  await expect(approval.locator('#content')).toBeVisible()
  return { result, approval }
}
async function decide(approval, name) {
  const closed = approval.waitForEvent('close')
  await approval.getByRole('button', { name, exact: true }).click()
  await closed
}

test('typed page provisioning uses fresh one-shot approval and exact numeric encrypted NIP-46 exchange', async ({ context, extensionId }) => {
  test.setTimeout(90_000)
  await withDeterministicNip46Signer(async signer => {
    const normal = signer.handleRequest.bind(signer)
    let expected, raw
    signer.handleRequest = request => {
      if (request.method === 'heartwood_provision_rendezvous') {
        expect(request.params).toEqual([target, 7, expected.nonce, expected.expiresAt])
        // Fixed public test scalar, exact Heartwood v1 inner record; no hardware derivation claim.
        const record = JSON.stringify({ v: 1, p: signer.pubkey, d: target, rz: child, u: 'rendezvous', i: 7, n: expected.nonce, e: expected.expiresAt, k: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url') })
        const c = encrypt(record, getConversationKey(new Uint8Array(32).fill(4), target))
        raw = JSON.stringify({ v: 1, p: signer.pubkey, d: target, rz: child, u: 'rendezvous', i: 7, n: expected.nonce, e: expected.expiresAt, c }, null, 1)
        return { result: raw }
      }
      return normal(request)
    }
    await withTestPage(async url => {
      await seedDeterministicSigner({ context, extensionId, origin: new URL(url).origin, bunkerUri: signer.bunkerUri, trustedOrigin: true })
      expect(await runtimeMessage(context, extensionId, { type: 'bark-prime-signer' })).toMatchObject({ ok: true })
      const page = await context.newPage()
      await page.goto(url)
      await expect.poll(() => page.evaluate(() => typeof window.nostr?.heartwood?.provisionRendezvousV1)).toBe('function')
      expect(await provision(page, { ...makeRequest(signer.pubkey), index: '7' })).toMatchObject({ ok: false })
      expect(signer.methods.filter(method => method === 'heartwood_provision_rendezvous')).toHaveLength(0)
      const denied = await begin(context, page, makeRequest(signer.pubkey))
      await expect(denied.approval.locator('#trust-section')).toBeHidden()
      await decide(denied.approval, 'Deny')
      expect(await denied.result).toMatchObject({ ok: false, error: 'Request denied by user.' })
      expected = makeRequest(signer.pubkey)
      const allowed = await begin(context, page, expected)
      await expect(allowed.approval.getByRole('heading', { name: 'Provision rendezvous child?' })).toBeVisible()
      await expect(allowed.approval.locator('#origin-text')).toContainText(new URL(url).origin)
      for (const value of [target, signer.pubkey, String(expected.index), String(expected.expiresAt)]) {
        await expect(allowed.approval.locator('#request-content')).toContainText(value)
      }
      await expect(allowed.approval.locator('#trust-section')).toBeHidden()
      await decide(allowed.approval, 'Allow Once')
      expect(await allowed.result).toEqual({ ok: true, result: raw })
      const unsealed = JSON.parse(decrypt(JSON.parse(raw).c, getConversationKey(new Uint8Array(32).fill(3), child)))
      expect(unsealed).toEqual({ v: 1, p: signer.pubkey, d: target, rz: child, u: 'rendezvous', i: 7, n: expected.nonce, e: expected.expiresAt, k: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url') })
      expect(getPublicKey(Buffer.from(unsealed.k, 'base64url'))).toBe(child)
      // Firmware encrypts this inner record as the child, not as the issuer.
      expect(() => decrypt(JSON.parse(raw).c, getConversationKey(new Uint8Array(32).fill(3), signer.pubkey))).toThrow()
      expect(signer.methods.filter(method => method === 'heartwood_provision_rendezvous')).toHaveLength(1)
      // The previous grant is consumed: the very same caller and parameters ask again.
      const again = await begin(context, page, expected)
      await decide(again.approval, 'Deny')
      expect(await again.result).toMatchObject({ ok: false })
      expect(signer.methods.filter(method => method === 'heartwood_provision_rendezvous')).toHaveLength(1)
      await page.close()
    })
  })
})
