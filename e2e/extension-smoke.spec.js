import { test, expect } from './extension.fixture.js'
import { withTestPage } from './nip46-test-helpers.js'

test('loads the packaged popup', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  await expect(page.getByRole('heading', { name: 'Bark' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Add Signer' })).toBeVisible()
  await expect(page.getByPlaceholder('heartwood.local:3000 or bunker://...')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pair by QR (nostrconnect)' })).toBeVisible()
})

test('injects the NIP-07 provider into a localhost page', async ({ context }) => {
  await withTestPage(async (url) => {
    const page = await context.newPage()
    try {
      await page.goto(url)

      await expect.poll(async () => {
        return await page.evaluate(() => ({
          nostr: typeof window.nostr,
          getPublicKey: typeof window.nostr?.getPublicKey,
          signEvent: typeof window.nostr?.signEvent,
          nip44Encrypt: typeof window.nostr?.nip44?.encrypt,
        }))
      }).toEqual({
        nostr: 'object',
        getPublicKey: 'function',
        signEvent: 'function',
        nip44Encrypt: 'function',
      })
    } finally {
      await page.close()
    }
  })
})

test('returns a safe unpaired error through window.nostr', async ({ context }) => {
  await withTestPage(async (url) => {
    const page = await context.newPage()
    try {
      await page.goto(url)

      await expect.poll(async () => {
        return await page.evaluate(() => typeof window.nostr?.getPublicKey)
      }).toBe('function')

      const error = await page.evaluate(async () => {
        try {
          await window.nostr.getPublicKey()
          return null
        } catch (err) {
          return err?.message || String(err)
        }
      })

      expect(error).toContain('No Heartwood instance configured')
      expect(error).not.toContain('Error:')
      expect(error).not.toContain('/')
    } finally {
      await page.close()
    }
  })
})
