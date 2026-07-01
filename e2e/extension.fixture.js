import { test as base, chromium, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '..', 'dist')

async function waitForExtensionWorker(context) {
  let [serviceWorker] = context.serviceWorkers()
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
  }
  return serviceWorker
}

export const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'bark-e2e-'))
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    })
    await waitForExtensionWorker(context)

    try {
      await use(context)
    } finally {
      await Promise.race([
        context.close(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ])
      await rm(userDataDir, { recursive: true, force: true })
    }
  },

  extensionId: async ({ context }, use) => {
    const serviceWorker = await waitForExtensionWorker(context)
    await use(new URL(serviceWorker.url()).host)
  },
})

export { expect }
