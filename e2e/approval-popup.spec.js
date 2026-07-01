import { verifyEvent } from 'nostr-tools/pure'
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
  await approvalPage.getByRole('button', { name }).click()
  await approvalPage.waitForEvent('close', { timeout: 10_000 }).catch(() => {})
}

async function expectSignedResult(result, signer, template) {
  expect(result.ok).toBe(true)
  expect(result.result).toMatchObject({
    kind: template.kind,
    content: template.content,
    pubkey: signer.pubkey,
  })
  expect(result.result.id).toMatch(/^[0-9a-f]{64}$/)
  expect(result.result.sig).toMatch(/^[0-9a-f]{128}$/)
  expect(verifyEvent(result.result)).toBe(true)
}

test('enforces approval popup deny, allow-once, trust-site, and protected-kind flows', async ({ context, extensionId }) => {
  test.setTimeout(120_000)

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

        const deniedTemplate = noteEvent('deny this untrusted signEvent', [['client', 'bark-approval-deny']])
        const denied = await submitSignRequestAndWaitForApproval(context, page, deniedTemplate)
        await expect(denied.approvalPage.getByRole('heading', { name: 'Sign Kind 1?' })).toBeVisible()
        await expect(denied.approvalPage.locator('#origin-text')).toContainText(origin)
        await clickDecision(denied.approvalPage, 'Deny')
        await expect(denied.resultPromise).resolves.toEqual({
          ok: false,
          error: 'Request denied by user.',
        })

        const allowOnceTemplate = noteEvent('allow this event once', [['client', 'bark-approval-allow-once']])
        const allowOnce = await submitSignRequestAndWaitForApproval(context, page, allowOnceTemplate)
        await clickDecision(allowOnce.approvalPage, 'Allow Once')
        await expectSignedResult(await allowOnce.resultPromise, signer, allowOnceTemplate)

        let stored = await readExtensionStorage(context, extensionId, ['policies'])
        expect(stored.policies.siteRules[origin]).toBeUndefined()

        const trustTemplate = noteEvent('trust routine signing for this site', [['client', 'bark-approval-trust']])
        const trust = await submitSignRequestAndWaitForApproval(context, page, trustTemplate)
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
