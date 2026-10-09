import { verifyEvent } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { test, expect } from './extension.fixture.js'
import {
  callNostrResult,
  readExtensionStorage,
  runtimeMessage,
  seedDeterministicSigner,
  withDeterministicNip46Signer,
  withTestPage,
} from './nip46-test-helpers.js'

async function waitForNostr(page) {
  await expect.poll(async () => {
    return await page.evaluate(() => typeof window.nostr?.signEvent)
  }).toBe('function')
}

async function waitForApprovalPage(context, timeout = 15_000) {
  const page = await context.waitForEvent('page', {
    predicate: candidate => candidate.url().includes('/approve.html'),
    timeout,
  })
  await page.waitForLoadState('domcontentloaded')
  return page
}

function noteEvent(content, tags = []) {
  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  }
}

function profileEvent(name) {
  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name,
      about: 'Bark approval popup E2E profile update',
    }),
  }
}

async function submitSignRequestAndWaitForApproval(context, page, event) {
  const approvalPagePromise = waitForApprovalPage(context)
  const resultPromise = callNostrResult(page, 'signEvent', event, 30_000)
  const approvalPage = await approvalPagePromise
  return { approvalPage, resultPromise }
}

async function clickDecision(approvalPage, name) {
  await expect(approvalPage.getByRole('button', { name })).toBeVisible()
  const closed = approvalPage.waitForEvent('close', { timeout: 10_000 })
  await approvalPage.getByRole('button', { name }).click()
  await closed
}

async function expectSignedResult(result, signer, template) {
  expect(result.ok, result.error).toBe(true)
  expect(result.result).toMatchObject({
    ...template,
    pubkey: signer.pubkey,
  })
  expect(result.result.id).toMatch(/^[0-9a-f]{64}$/)
  expect(result.result.sig).toMatch(/^[0-9a-f]{128}$/)
  expect(verifyEvent(result.result)).toBe(true)
}

test('enforces approval popup deny, allow-once, trust-site, and protected-kind flows', async ({ context, extensionId }) => {
  test.setTimeout(150_000)

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
          trustedOrigin: false,
        })

        const primeResult = await runtimeMessage(context, extensionId, {
          type: 'bark-prime-signer',
        }, 35_000)
        expect(primeResult).toMatchObject({ ok: true, pubkey: signer.pubkey })

        page = await context.newPage()
        await page.goto(url)
        await waitForNostr(page)

        // First-use identity requests must be visible in the page even when
        // the browser opens Bark's approval window behind the current window.
        const publicKeyApprovalPagePromise = waitForApprovalPage(context)
        const publicKeyResultPromise = callNostrResult(page, 'getPublicKey', undefined, 30_000)
        const publicKeyApprovalPage = await publicKeyApprovalPagePromise
        await expect(publicKeyApprovalPage.locator('#persona-name')).toHaveText('Connected identity')
        await publicKeyApprovalPage.getByText('Show full public key', { exact: true }).click()
        await expect(publicKeyApprovalPage.locator('#persona-full-key')).toHaveText(npubEncode(signer.pubkey))
        await expect(page.getByText('Bark needs your approval')).toBeVisible()
        const reviewInBark = page.getByRole('button', { name: 'Review in Bark' })
        await expect(reviewInBark).toBeVisible()
        await reviewInBark.click()
        await clickDecision(publicKeyApprovalPage, 'Allow Once')
        await expect(publicKeyResultPromise).resolves.toEqual({ ok: true, result: signer.pubkey })
        await expect(page.locator('#bark-approval-notice-host')).toHaveCount(0)

        const deniedTemplate = noteEvent('deny this untrusted signEvent', [['client', 'bark-approval-deny']])
        const denied = await submitSignRequestAndWaitForApproval(context, page, deniedTemplate)
        await expect(denied.approvalPage.getByRole('heading', { name: 'Sign Note?' })).toBeVisible()
        await expect(denied.approvalPage.locator('#origin-text')).toContainText(origin)
        await expect(denied.approvalPage.locator('#request-content')).toHaveText(deniedTemplate.content)
        await expect(denied.approvalPage.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
        expect(await denied.approvalPage.evaluate(() => window.scrollY)).toBe(0)
        // A failed delivery must keep the request open for retry rather than
        // making the user believe their decision reached the background.
        await denied.approvalPage.evaluate(() => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime)
          let failOnce = true
          chrome.runtime.sendMessage = (message, callback) => {
            if (message.type === 'bark-approval-response' && failOnce) {
              failOnce = false
              callback({ ok: false, error: 'Simulated delivery failure' })
              return
            }
            sendMessage(message, callback)
          }
        })
        await denied.approvalPage.getByRole('button', { name: 'Deny', exact: true }).click()
        await expect(denied.approvalPage.getByRole('alert')).toContainText('could not send your decision')
        await expect(denied.approvalPage.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
        await expect(denied.approvalPage.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
        expect(denied.approvalPage.isClosed()).toBe(false)
        await clickDecision(denied.approvalPage, 'Deny')
        await expect(denied.resultPromise).resolves.toEqual({
          ok: false,
          error: 'Request denied by user.',
        })

        const literalContent = 'Review this exactly:\n<img src="https://preview.invalid/image.png" onerror="window.previewExecuted = true">\n<script>window.previewExecuted = true</script>'
        const allowOnceTemplate = noteEvent(literalContent, [
          ['client', 'bark-approval-allow-once'],
          ['p', '33'.repeat(32)],
        ])
        const allowOnce = await submitSignRequestAndWaitForApproval(context, page, allowOnceTemplate)
        await expect(allowOnce.approvalPage.locator('#request-content')).toHaveText(literalContent)
        await expect(allowOnce.approvalPage.locator('img[src^="https:"]')).toHaveCount(0)
        expect(await allowOnce.approvalPage.evaluate(() => window.previewExecuted)).toBeUndefined()
        await allowOnce.approvalPage.getByText('Review full event', { exact: true }).click()
        const reviewedEvent = JSON.parse(await allowOnce.approvalPage.locator('#event-json').textContent())
        expect(reviewedEvent).toEqual(allowOnceTemplate)
        await clickDecision(allowOnce.approvalPage, 'Allow Once')
        await expectSignedResult(await allowOnce.resultPromise, signer, allowOnceTemplate)

        let stored = await readExtensionStorage(context, extensionId, ['policies'])
        expect(stored.policies.siteRules[origin]).toBeUndefined()

        // Select the tenfold review time before requesting approval. The real
        // provider/content bridge must also extend its bounded page wait.
        const settingsPage = await context.newPage()
        await settingsPage.goto(`chrome-extension://${extensionId}/popup.html`)
        await settingsPage.locator('#accessibility-settings summary').click()
        await settingsPage.getByLabel('Time to review approvals', { exact: true }).selectOption('600000')
        await expect(settingsPage.locator('#accessibility-status')).toContainText('saved')
        await settingsPage.close()
        await page.evaluate(() => {
          window.approvalWait = null
          window.approvalWaits = []
          window.addEventListener('message', event => {
            if (event.source === window && event.data?.type === 'bark-approval-wait') {
              window.approvalWait = event.data
              window.approvalWaits.push(event.data)
            }
          })
        })
        const expired = await submitSignRequestAndWaitForApproval(context, page, noteEvent('expired requests must never sign or trust'))
        const expiredId = new URL(expired.approvalPage.url()).searchParams.get('requestId')
        const timing = await runtimeMessage(context, extensionId, { type: 'bark-approval-query', requestId: expiredId })
        expect(timing.approvalTimeoutMs).toBe(600000)
        expect(timing.expiresAt - Date.now()).toBeGreaterThan(590000)
        await expect.poll(() => page.evaluate(() => window.approvalWait?.waitMs)).toBe(2520000)
        const expiredQueuedResult = callNostrResult(page, 'signEvent', noteEvent('expired queued requests must not reopen'), 30_000)
        await expect.poll(() => page.evaluate(() => window.approvalWaits.length)).toBe(2)
        const signCount = signer.methods.filter(method => method === 'sign_event').length
        const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith('/background.js'))
        // Simulate a suspended worker's late timer without waiting ten minutes.
        // Only the worker clock changes, so this checks background authority.
        await worker.evaluate(deadline => {
          globalThis.originalApprovalClock = Date.now
          Date.now = () => deadline + 1_800_001
        }, timing.expiresAt)
        try {
          const lateDecision = await runtimeMessage(context, extensionId, {
            type: 'bark-approval-response', requestId: expiredId, decision: 'allow-site',
          })
          expect(lateDecision).toMatchObject({ ok: false, error: 'Approval request expired or unavailable.' })
          await expect(expired.resultPromise).resolves.toEqual({ ok: false, error: 'Approval timed out.' })
          await expect(expiredQueuedResult).resolves.toEqual({ ok: false, error: 'Approval timed out.' })
        } finally {
          await worker.evaluate(() => { Date.now = globalThis.originalApprovalClock; delete globalThis.originalApprovalClock })
          await expired.approvalPage.close()
        }
        expect(signer.methods.filter(method => method === 'sign_event').length).toBe(signCount)
        stored = await readExtensionStorage(context, extensionId, ['policies'])
        expect(stored.policies.siteRules[origin]).toBeUndefined()

        // Concurrent requests queue instead of rejecting: the kind 1 popup is
        // denied and the kind 42 popup (whichever order they appear) is allowed.
        const queuedNote = noteEvent('queued approval: deny me', [['client', 'bark-approval-queue-deny']])
        const queuedChannel = {
          kind: 42,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['client', 'bark-approval-queue-allow']],
          content: 'queued approval: allow me',
        }
        await page.evaluate(() => { window.approvalWaits = [] })
        const firstQueuedPromise = waitForApprovalPage(context)
        const queuedNoteResult = callNostrResult(page, 'signEvent', queuedNote, 60_000)
        const queuedChannelResult = callNostrResult(page, 'signEvent', queuedChannel, 60_000)
        const firstQueued = await firstQueuedPromise
        // Both reach the worker while the first is still awaiting a decision:
        // neither promise can expire on the old short page-side deadline.
        await expect.poll(() => page.evaluate(() => window.approvalWaits.map(wait => wait.waitMs))).toEqual([2520000, 2520000])
        const firstIsNote = (await firstQueued.locator('#title').textContent()).includes('Note')
        const secondQueuedPromise = waitForApprovalPage(context)
        if (!firstIsNote) await expect(firstQueued.locator('#request-warning')).toBeVisible()
        await clickDecision(firstQueued, firstIsNote ? 'Deny' : 'Allow Once')
        const secondQueued = await secondQueuedPromise
        if (firstIsNote) await expect(secondQueued.locator('#request-warning')).toBeVisible()
        await clickDecision(secondQueued, firstIsNote ? 'Allow Once' : 'Deny')
        await expect(queuedNoteResult).resolves.toEqual({
          ok: false,
          error: 'Request denied by user.',
        })
        await expectSignedResult(await queuedChannelResult, signer, queuedChannel)

        const trustTemplate = noteEvent('trust routine signing for this site', [['client', 'bark-approval-trust']])
        const trust = await submitSignRequestAndWaitForApproval(context, page, trustTemplate)
        await expect(trust.approvalPage.locator('#trust-section')).toContainText('encryption and decryption')
        await clickDecision(trust.approvalPage, 'Trust Site')
        await expectSignedResult(await trust.resultPromise, signer, trustTemplate)

        stored = await readExtensionStorage(context, extensionId, ['policies'])
        expect(stored.policies.siteRules[origin]).toMatchObject({
          getPublicKey: 'allow',
          getRelays: 'allow',
          signEvent: 'allow',
        })

        const trustedRoutineTemplate = noteEvent('trusted routine event signs without another popup', [['client', 'bark-approval-trusted']])
        const unexpectedApprovalPromise = waitForApprovalPage(context, 2_000).catch(() => null)
        const trustedRoutinePromise = callNostrResult(page, 'signEvent', trustedRoutineTemplate, 30_000)
        const unexpectedApproval = await unexpectedApprovalPromise
        if (unexpectedApproval) await clickDecision(unexpectedApproval, 'Deny')
        expect(unexpectedApproval).toBeNull()
        await expectSignedResult(await trustedRoutinePromise, signer, trustedRoutineTemplate)

        const protectedTemplate = profileEvent('bark-approval-protected')
        const protectedRequest = await submitSignRequestAndWaitForApproval(context, page, protectedTemplate)
        await expect(protectedRequest.approvalPage.getByRole('heading', { name: 'Sign Profile Metadata?' })).toBeVisible()
        await expect(protectedRequest.approvalPage.locator('#profile-fields')).toContainText('bark-approval-protected')
        await clickDecision(protectedRequest.approvalPage, 'Allow Once')
        await expectSignedResult(await protectedRequest.resultPromise, signer, protectedTemplate)

        expect(signer.methods.filter((method) => method === 'sign_event').length).toBeGreaterThanOrEqual(5)
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
      title: 'Bark Approval E2E',
      body: 'Bark Approval E2E host page',
    })
  })
})
