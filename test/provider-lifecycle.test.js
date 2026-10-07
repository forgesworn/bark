import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { it, expect, vi } from 'vitest'

it('rejects outstanding page requests when extension reload invalidates the bridge', async () => {
  const handlers = []
  const window = {
    location: { origin: 'https://app.example' },
    addEventListener: (_type, listener) => handlers.push(listener),
    postMessage: vi.fn(),
  }
  const banner = { style: {}, appendChild: vi.fn(), addEventListener: vi.fn() }
  const body = { appendChild: vi.fn() }
  const clear = vi.fn(clearTimeout)
  runInNewContext(readFileSync(new URL('../src/provider.js', import.meta.url), 'utf8'), {
    window, document: { createElement: () => banner, body }, setTimeout, clearTimeout: clear,
  })
  const request = window.nostr.getPublicKey()
  const rejected = expect(request).rejects.toThrow('Please refresh the page')
  const [{ id }] = window.postMessage.mock.calls[0]
  for (const listener of handlers) listener({ source: window, origin: window.location.origin,
    data: { type: 'bark-response', id, error: 'Bark was updated. Please refresh the page.' } })
  await rejected
  expect(body.appendChild).toHaveBeenCalledOnce()
  expect(clear).toHaveBeenCalledOnce()
})
