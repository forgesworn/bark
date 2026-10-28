import { test, expect } from './extension.fixture.js'
import { withDeterministicNip46Signer, withTestPage, seedDeterministicSigner, runtimeMessage, readExtensionStorage } from './nip46-test-helpers.js'

async function request(context, page, method, peer, input) {
  const popupPromise = context.waitForEvent('page', { predicate: p => p.url().includes('/approve.html') })
  const resultPromise = page.evaluate(({ method, peer, input }) => {
    const [protocol, operation] = method.split('.')
    return window.nostr[protocol][operation](peer, input).then(result => ({ ok: true, result }), error => ({ ok: false, error: error.message }))
  }, { method, peer, input })
  const popup = await popupPromise
  await popup.locator('#crypto-request').waitFor({ state: 'visible' })
  return { popup, resultPromise }
}
async function decide(popup, name) {
  const closed = popup.waitForEvent('close')
  await popup.getByRole('button', { name, exact: true }).click()
  await closed
}

test('crypto consent shows the exact peer and optional bounded literal input without changing approval or execution', async ({ context, extensionId }) => {
  test.setTimeout(150_000)
  const previewRequests = []
  context.on('request', request => { if (new URL(request.url()).hostname === 'crypto-preview.invalid') previewRequests.push(request.url()) })
  await withDeterministicNip46Signer(async signer => {
    await withTestPage(async url => {
      const origin = new URL(url).origin
      await seedDeterministicSigner({ context, extensionId, origin, bunkerUri: signer.bunkerUri, trustedOrigin: false })
      await runtimeMessage(context, extensionId, { type: 'bark-prime-signer' }, 35_000)
      const page = await context.newPage(); await page.goto(url)
      await expect.poll(() => page.evaluate(() => typeof window.nostr?.nip44?.encrypt)).toBe('function')
      const peer = signer.pubkey
      const input = '0123456789abcdef'.repeat(4)
      const encrypted = await request(context, page, 'nip44.encrypt', peer, input)
      await expect(encrypted.popup.locator('#crypto-peer-short')).toBeVisible()
      await expect(encrypted.popup.locator('#crypto-peer-details')).not.toHaveAttribute('open', '')
      await encrypted.popup.getByText('Show full peer public key', { exact: true }).click()
      await expect(encrypted.popup.locator('#crypto-peer-key')).toHaveText(peer)
      await expect(encrypted.popup.locator('#crypto-input-details')).not.toHaveAttribute('open', '')
      await expect(encrypted.popup.locator('#crypto-input-text')).not.toBeVisible()
      await encrypted.popup.getByText('Request details', { exact: true }).click()
      await expect(encrypted.popup.locator('#crypto-method')).toHaveText('nip44.encrypt')
      await expect(encrypted.popup.locator('#crypto-input-label')).toHaveText('Plaintext to encrypt')
      await expect(encrypted.popup.locator('#crypto-input-text')).toHaveText(input)
      await expect(encrypted.popup.locator('#crypto-input-text')).toHaveAttribute('data-complete', 'true')
      await expect(encrypted.popup.locator('#crypto-input-status')).toHaveText('Complete input: 64 UTF-8 bytes.')
      const requestId = new URL(encrypted.popup.url()).searchParams.get('requestId')
      const first = await runtimeMessage(context, extensionId, { type: 'bark-approval-query', requestId })
      const again = await runtimeMessage(context, extensionId, { type: 'bark-approval-query', requestId })
      expect(again.crypto).toEqual(first.crypto)
      expect(first.crypto.inputPreview).toBe(input)
      expect(first.params).toBeUndefined()
      await decide(encrypted.popup, 'Allow Once')
      const encryption = await encrypted.resultPromise; expect(encryption.ok).toBe(true)
      const decrypted = await request(context, page, 'nip44.decrypt', peer, encryption.result)
      await decrypted.popup.getByText('Request details', { exact: true }).click()
      await expect(decrypted.popup.locator('#crypto-input-label')).toHaveText('Ciphertext to decrypt')
      await expect(decrypted.popup.locator('#crypto-input-text')).toHaveText(encryption.result)
      await decide(decrypted.popup, 'Allow Once')
      expect(await decrypted.resultPromise).toEqual({ ok: true, result: input })
      expect((await readExtensionStorage(context, extensionId, ['policies'])).policies.siteRules[origin]).toBeUndefined()

      const literal = '<img src="https://crypto-preview.invalid/image.png" onerror="window.previewExecuted=true"><script>window.previewExecuted=true</script>'
      for (const method of ['nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt']) {
        const before = signer.methods.length
        const denied = await request(context, page, method, peer, literal)
        await denied.popup.getByText('Request details', { exact: true }).click()
        await expect(denied.popup.locator('#crypto-input-text')).toHaveText(literal)
        await expect(denied.popup.locator('img[src^="https:"]')).toHaveCount(0)
        expect(await denied.popup.evaluate(() => window.previewExecuted)).toBeUndefined()
        await decide(denied.popup, 'Deny')
        expect((await denied.resultPromise).ok).toBe(false)
        expect(signer.methods.slice(before).some(m => /nip(04|44)_(encrypt|decrypt)/.test(m))).toBe(false)
      }
      expect(previewRequests).toEqual([])
      const large = await request(context, page, 'nip44.encrypt', peer, '💚'.repeat(1100))
      await large.popup.getByText('Request details', { exact: true }).click()
      await expect(large.popup.locator('#crypto-input-text')).toHaveAttribute('data-complete', 'false')
      await expect(large.popup.locator('#crypto-input-status')).toHaveText('Incomplete preview: showing 4096 of 4400 UTF-8 bytes. The full input will be used if you allow this request.')
      expect(await large.popup.locator('#crypto-input-text').textContent()).toBe('💚'.repeat(1024))
      await decide(large.popup, 'Deny'); expect((await large.resultPromise).ok).toBe(false)
      await page.close()
    })
  })
})
