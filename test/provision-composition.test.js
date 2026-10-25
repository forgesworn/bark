// Real provider -> background listener/approval queue composition. Only browser
// APIs and the already-connected remote signer boundary are synthetic here.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { getPublicKey } from 'nostr-tools/pure'
import { DEFAULT_POLICIES, buildTrustedSiteRule } from '../src/policy.js'
const pubkey = n => getPublicKey(new Uint8Array(32).fill(n))
const key = pubkey(1), target = pubkey(2)
const request = () => ({ v: 1, expectedPersona: key, targetDevice: target, index: 7, nonce: 'AAECAwQFBgcICQoLDA0ODw', expiresAt: Math.floor(Date.now() / 1000) + 300 })
const reply = value => JSON.stringify({ v: 1, p: key, d: target, rz: pubkey(3), u: 'rendezvous', i: value.index, n: value.nonce, e: value.expiresAt, c: 'A'.repeat(132) })
const provider = buildSync({ entryPoints: [fileURLToPath(new URL('../src/provider.js', import.meta.url))], bundle: true, format: 'iife', write: false }).outputFiles[0].text
let handler, storageListener, tabRemoved, background, remote, stored, chrome, opened, window, identity, pendingResponse
const sender = { id: 'bark', tab: { id: 8, url: 'https://app.example/path' }, frameId: 0, origin: 'https://app.example', url: 'https://app.example/path' }
const internal = { id: 'bark', url: 'chrome-extension://bark/approve.html' }
const rpc = (message, from = internal) => new Promise(resolve => handler(message, from, resolve))
const ticks = async () => { for (let n = 0; n < 35; n++) await Promise.resolve() }
const approval = () => new URL(opened[opened.length - 1].url).searchParams.get('requestId')
const decide = decision => rpc({ type: 'bark-approval-response', requestId: approval(), decision })
const change = (id = 'other') => { const oldValue = stored.activeInstanceId; stored.activeInstanceId = id; storageListener({ activeInstanceId: { oldValue, newValue: id } }, 'local') }

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  identity = key; opened = []
  stored = { activeInstanceId: 'one', instances: [{ id: 'one', bunkerUri: 'bunker://' + key, clientSecret: '11'.repeat(32) }], policies: { ...DEFAULT_POLICIES, siteRules: { 'https://app.example': { ...buildTrustedSiteRule(), heartwood_provision_rendezvous: 'allow' } } } }
  chrome = { runtime: { id: 'bark', getURL: name => 'chrome-extension://bark/' + name, onMessage: { addListener: fn => { handler = fn } } },
    storage: { local: { get: vi.fn(async () => structuredClone(stored)), set: vi.fn(async value => Object.assign(stored, value)) }, onChanged: { addListener: fn => { storageListener = fn } } },
    windows: { create: vi.fn(async value => { opened.push(value); return { id: opened.length } }) },
    tabs: { sendMessage: vi.fn(async () => {}), onRemoved: { addListener: fn => { tabRemoved = fn } } } }
  vi.stubGlobal('chrome', chrome)
  background = await import('../src/background.js')
  remote = { pool: { relays: new Map([['relay', { connected: true }]]) }, close: vi.fn(), sendRequest: vi.fn(async method => method === 'get_public_key' ? identity : pendingResponse), getPublicKey: vi.fn(async () => key) }
  background.__setSignerForTest(remote)
  const listeners = []
  window = { location: { origin: sender.origin }, addEventListener: (_type, fn) => listeners.push(fn), postMessage: message => {
    if (message.type !== 'bark-request') return
    handler({ ...message, type: 'bark-request', pageRequestId: message.id }, sender, result => {
      const data = result?.error ? { type: 'bark-response', id: message.id, error: result.error } : { type: 'bark-response', id: message.id, result }
      listeners.forEach(fn => fn({ source: window, origin: sender.origin, data }))
    })
  } }
  runInNewContext(provider, { window, document: {}, setTimeout, clearTimeout })
})
afterEach(async () => { await background.resetConnection(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('typed provider / real approval queue', () => {
  it('prompts on every trusted-site request and returns the exact opaque envelope once', async () => {
    const value = request(); pendingResponse = reply(value)
    const first = window.nostr.heartwood.provisionRendezvousV1(value)
    await ticks()
    expect(opened).toHaveLength(1)
    const details = await rpc({ type: 'bark-approval-query', requestId: approval() })
    expect(details).toMatchObject({ canTrustSite: false, origin: sender.origin, pubkey: key, provision: value })
    expect(remote.sendRequest.mock.calls.map(call => call[0])).toEqual(['get_public_key'])
    await decide('allow-once')
    await expect(first).resolves.toBe(pendingResponse)
    expect(remote.sendRequest).toHaveBeenCalledWith('heartwood_provision_rendezvous', [target, 7, value.nonce, value.expiresAt])
    const count = remote.sendRequest.mock.calls.length
    await decide('allow-once')
    expect(remote.sendRequest.mock.calls.length).toBe(count)
    const next = window.nostr.heartwood.provisionRendezvousV1(value); await ticks()
    expect(opened).toHaveLength(2); await decide('deny'); await expect(next).rejects.toThrow('denied')
  })
  it('rejects malformed input and insecure origins before any RPC or prompt', async () => {
    await expect(window.nostr.heartwood.provisionRendezvousV1({ ...request(), index: '7' })).rejects.toThrow('unavailable')
    expect(await rpc({ type: 'bark-request', method: 'heartwood_provision_rendezvous', params: request() }, { ...sender, origin: 'http://app.example', url: 'http://app.example' })).toHaveProperty('error')
    expect(remote.sendRequest).not.toHaveBeenCalled(); expect(opened).toHaveLength(0)
  })
  it('refuses the wrong selected account before showing approval', async () => {
    identity = pubkey(4)
    await expect(window.nostr.heartwood.provisionRendezvousV1(request())).rejects.toThrow('unavailable')
    expect(opened).toHaveLength(0)
  })
  it.each(['allow-site', 'deny'])('cannot approve via %s or persist a site grant', async decision => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    await decide(decision); await expect(result).rejects.toThrow('denied')
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })
  it('holds an approval after an instance switch away and back', async () => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    change(); change('one'); await decide('allow-once'); await expect(result).rejects.toThrow('identity changed')
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
  })
  it('holds a remote account change before dispatch', async () => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    identity = pubkey(4); await decide('allow-once'); await expect(result).rejects.toThrow('identity changed')
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
  })
  it.each(['instance', 'account', 'connection'])('holds a reply when %s changes during the RPC', async kind => {
    const value = request(); let finish
    remote.sendRequest.mockImplementation(async method => method === 'get_public_key' ? identity : new Promise(resolve => { finish = resolve }))
    const result = window.nostr.heartwood.provisionRendezvousV1(value); await ticks(); await decide('allow-once'); await ticks()
    expect(finish).toBeTypeOf('function')
    if (kind === 'instance') { change(); change('one') }
    if (kind === 'account') identity = pubkey(4)
    if (kind === 'connection') background.__setSignerForTest({ ...remote })
    finish(reply(value)); await expect(result).rejects.toThrow('identity changed')
  })
  it.each(['deny', 'hide'])('rechecks %s after approval opens and before provisioning RPC', async kind => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    if (kind === 'deny') stored.policies.siteRules[sender.origin].heartwood_provision_rendezvous = 'deny'
    else { stored.privacy = { enabled: true }; stored.policies.siteRules = {} }
    await decide('allow-once'); await expect(result).rejects.toThrow('failed')
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
  })
  it.each(['deny', 'hide'])('holds a reply after policy changes to %s during provisioning RPC', async kind => {
    const value = request(); let finish
    remote.sendRequest.mockImplementation(async method => method === 'get_public_key' ? identity : new Promise(resolve => { finish = resolve }))
    const result = window.nostr.heartwood.provisionRendezvousV1(value); await ticks(); await decide('allow-once'); await ticks()
    expect(finish).toBeTypeOf('function')
    if (kind === 'deny') stored.policies.siteRules[sender.origin].heartwood_provision_rendezvous = 'deny'
    else { stored.privacy = { enabled: true }; stored.policies.siteRules = {} }
    finish(reply(value)); await expect(result).rejects.toThrow('failed')
  })
  it('cancels queued approval when the requesting tab closes', async () => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    tabRemoved(sender.tab.id); await expect(result).rejects.toThrow('denied')
    await decide('allow-once')
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
  })
  it('holds an in-flight reply after the requesting tab closes', async () => {
    const value = request(); let finish
    remote.sendRequest.mockImplementation(async method => method === 'get_public_key' ? identity : new Promise(resolve => { finish = resolve }))
    const result = window.nostr.heartwood.provisionRendezvousV1(value); await ticks(); await decide('allow-once'); await ticks()
    tabRemoved(sender.tab.id); finish(reply(value)); await expect(result).rejects.toThrow('failed')
  })
  it('uses the frozen approved request even if caller-owned input changes later', async () => {
    const value = request(); const original = { ...value }; pendingResponse = reply(original)
    const result = window.nostr.heartwood.provisionRendezvousV1(value); await ticks()
    value.targetDevice = pubkey(4); value.index = 8
    await decide('allow-once'); await expect(result).resolves.toBe(pendingResponse)
    expect(remote.sendRequest).toHaveBeenCalledWith('heartwood_provision_rendezvous', [original.targetDevice, original.index, original.nonce, original.expiresAt])
  })
  it('holds requests whose child expiry elapsed during approval', async () => {
    const value = request(); const result = window.nostr.heartwood.provisionRendezvousV1(value); await ticks()
    vi.setSystemTime(value.expiresAt * 1000)
    await decide('allow-once'); await expect(result).rejects.toThrow()
    expect(remote.sendRequest).not.toHaveBeenCalledWith('heartwood_provision_rendezvous', expect.anything())
  })
  it('never forwards remote exception text as a secret-bearing result or error', async () => {
    const result = window.nostr.heartwood.provisionRendezvousV1(request()); await ticks()
    remote.sendRequest.mockImplementation(async method => { if (method === 'get_public_key') return identity; throw new Error('synthetic-sensitive-response-must-not-escape') })
    await decide('allow-once'); await expect(result).rejects.toThrow('Rendezvous provisioning failed or identity changed. Please retry.')
  })
  it('does not expose internal-only bypass or arbitrary RPC', async () => {
    expect(window.nostr.heartwood.sendRequest).toBeUndefined()
    const value = await rpc({ type: 'bark-request', method: 'heartwood_provision_rendezvous', params: request() })
    expect(value).toHaveProperty('error'); expect(opened).toHaveLength(0); expect(remote.sendRequest).not.toHaveBeenCalled()
  })
})
