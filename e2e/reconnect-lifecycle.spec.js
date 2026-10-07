import { test, expect } from './extension.fixture.js'
import { callNostr, seedDeterministicSigner, withDeterministicNip46Signer, withTestPage,
  runtimeMessage, readExtensionStorage } from './nip46-test-helpers.js'

test('late handshake reply serves concurrent callers and releases sockets on reset', async ({ context, extensionId }) => {
  test.setTimeout(60_000)
  await withDeterministicNip46Signer(async remote => {
    await withTestPage(async url => {
      await seedDeterministicSigner({ context, extensionId, origin: new URL(url).origin, bunkerUri: remote.bunkerUri })
      const before = await readExtensionStorage(context, extensionId, ['instances', 'activeInstanceId'])
      const pages = await Promise.all([context.newPage(), context.newPage()])
      await Promise.all(pages.map(page => page.goto(url)))
      const keys = await Promise.all(pages.map(page => callNostr(page, 'getPublicKey')))
      expect(keys).toEqual([remote.pubkey, remote.pubkey])
      expect(remote.methods.filter(m => m === 'connect')).toHaveLength(2)
      await runtimeMessage(context, extensionId, { type: 'bark-reset' })
      await expect.poll(() => remote.connections.size).toBe(0)
      const after = await readExtensionStorage(context, extensionId, ['instances', 'activeInstanceId'])
      expect(after.activeInstanceId).toBe(before.activeInstanceId)
      expect(after.instances[0].clientSecret).toBe(before.instances[0].clientSecret)
      expect(after.instances[0].bunkerUri).toBe(before.instances[0].bunkerUri)
    })
  }, { firstConnectDelayMs: 7000, ignoreLaterConnects: true })
})

test('popup shows a refusal without starting a retry storm', async ({ context, extensionId }) => {
  await withDeterministicNip46Signer(async remote => {
    await seedDeterministicSigner({ context, extensionId, bunkerUri: remote.bunkerUri })
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(popup.locator('#reconnect-msg')).toHaveText('unauthorised')
    await expect(popup.locator('#retry-btn')).toBeVisible()
    // Cross the earliest background/popup backoff boundary.
    await popup.waitForTimeout(6500)
    expect(remote.methods.filter(m => m === 'connect')).toHaveLength(1)
    await expect.poll(() => remote.connections.size).toBe(0)
  }, { connectError: 'unauthorised' })
})

test('recovers after lost relay sockets using the original pairing', async ({ context, extensionId }) => {
  await withDeterministicNip46Signer(async remote => {
    await withTestPage(async url => {
      await seedDeterministicSigner({ context, extensionId, origin: new URL(url).origin, bunkerUri: remote.bunkerUri })
      const page = await context.newPage()
      await page.goto(url)
      expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
      for (const socket of remote.connections) socket.terminate()
      await expect.poll(() => remote.connections.size).toBe(0)
      expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
      expect(remote.methods.filter(m => m === 'connect')).toHaveLength(2)
      await runtimeMessage(context, extensionId, { type: 'bark-reset' })
      await expect.poll(() => remote.connections.size).toBe(0)
    })
  })
})


test('signing survives a human-paced idle gap and an explicit reconnect', async ({ context, extensionId }) => {
  test.setTimeout(90_000)
  await withDeterministicNip46Signer(async remote => {
    await withTestPage(async url => {
      await seedDeterministicSigner({ context, extensionId, origin: new URL(url).origin, bunkerUri: remote.bunkerUri })
      const page = await context.newPage()
      await page.goto(url)
      expect(await callNostr(page, 'getPublicKey')).toBe(remote.pubkey)
      await page.waitForTimeout(45_000)
      const template = { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'after idle' }
      expect((await callNostr(page, 'signEvent', template)).pubkey).toBe(remote.pubkey)
      await runtimeMessage(context, extensionId, { type: 'bark-reset' })
      expect((await callNostr(page, 'signEvent', { ...template, content: 'after reset' })).pubkey).toBe(remote.pubkey)
      await runtimeMessage(context, extensionId, { type: 'bark-reset' })
      await expect.poll(() => remote.connections.size).toBe(0)
    })
  })
})
