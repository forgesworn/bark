// Packaged UI with controlled extension API/storage data. Real signing is
// separately exercised by approval-popup.spec.js and nip46-relay-signer.spec.js.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { npubEncode } from 'nostr-tools/nip19'
const require = createRequire(import.meta.url)
const messages = JSON.parse(await readFile(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')
const pubkey = '22'.repeat(32)
const otherKey = '33'.repeat(32)
const npub = npubEncode(pubkey)
const policies = { version: 2, defaults: {}, kindRules: { '0': 'ask', '3': 'ask', '10002': 'ask' }, siteRules: { 'https://example.com': { getPublicKey: 'allow', signEvent: 'allow', 'nip44.decrypt': 'ask', kindRules: { '1': 'ask' } } } }
const instances = [
  { id: 'work', name: 'Work signer', address: 'local fixture', isHeartwood: true, npub, heartwoodIdentityPubkey: pubkey, heartwoodIdentityLabel: 'work' },
  { id: 'personal', name: 'Personal signer', address: 'local fixture', isHeartwood: true, npub: npubEncode(otherKey), heartwoodIdentityPubkey: otherKey, heartwoodIdentityLabel: 'personal' },
]
export async function renderedBark(context, { paired = false, approval = false, height = 700, remainingMs = 60_000 } = {}) {
  const page = await context.newPage()
  await page.setViewportSize({ width: 320, height })
  await page.addInitScript(({ messages, data, pubkey, otherKey, remainingMs }) => {
    window.fixtureCalls = []
    const storage = window.barkUiStorage = structuredClone(data)
    const api = {
      i18n: { getMessage(key, substitutions = []) {
        const entry = messages[key]
        if (!entry) return ''
        const values = Array.isArray(substitutions) ? substitutions : [substitutions]
        return entry.message.replace(/\$(\w+)\$/g, (_, name) => (entry.placeholders?.[name.toLowerCase()]?.content || '').replace(/\$(\d+)/g, (_, n) => values[Number(n) - 1] || ''))
      } },
      tabs: { query(options, callback) { callback([]) }, create() {} },
      storage: { local: {
        get(keys, callback) {
          const selected = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(storage)
          callback(Object.fromEntries(selected.filter(key => key in storage).map(key => [key, storage[key]])))
        },
        set(items, callback) { Object.assign(storage, items); callback?.() },
        remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; callback?.() },
      } },
      runtime: { sendMessage(message, callback) {
        window.fixtureCalls.push(message)
        let result = { ok: true }
        if (message.type === 'bark-status') result = { status: 'connected', isHeartwood: true, signingStatus: 'ready', relays: [{ url: 'wss://relay.example.com', connected: true }, { url: 'wss://offline.example.com', connected: false }] }
        if (message.type === 'bark-request') {
          if (message.method === 'getPublicKey') result = storage.activeInstanceId === 'personal' ? otherKey : pubkey
          if (message.method === 'heartwood_list_identities') result = [{ name: 'work', pubkey }, { name: 'personal', pubkey: otherKey }]
        }
        if (message.type === 'bark-switch') storage.activeInstanceId = message.instanceId
        if (message.type === 'bark-approval-query') result = { expiresAt: Date.now() + remainingMs, approvalTimeoutMs: 60_000, method: 'signEvent', origin: 'https://example.com', pubkey, personaName: 'Work signer', canTrustSite: true, event: { kind: 1, created_at: 100, tags: [], content: 'Please review this note before signing.\n\nA second paragraph to check the approval layout.' } }
        if (message.type === 'bark-nostrconnect-start') result = { ok: true, uri: `nostrconnect://${pubkey}?relay=wss%3A%2F%2Frelay.example.com&secret=fixture` }
        if (message.type === 'bark-nostrconnect-status') result = { status: 'waiting' }
        queueMicrotask(() => callback(result))
      } },
    }
    window.chrome = api
  }, { messages, pubkey, otherKey, remainingMs, data: { instances: paired ? instances : [], activeInstanceId: paired ? 'work' : null, policies, privacy: { enabled: true } } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://bark-audit.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.png') ? 'image/png' : 'text/html'
    await route.fulfill({ body: await readFile(new URL(`../dist${pathname}`, import.meta.url)), contentType })
  })
  await page.goto(`http://bark-audit.test/${approval ? 'approve' : 'popup'}.html${approval ? '?requestId=fixture' : ''}`)
  await page.locator(approval ? '#content' : paired ? '#connected-content' : '#setup-screen').waitFor({ state: 'visible' })
  return { page, errors }
}

export async function wcagViolations(page) {
  await page.evaluate(axeSource)
  return page.evaluate(async () => {
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })
    return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))
  })
}
