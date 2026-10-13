import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { it, expect, vi } from 'vitest'

const provider = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/provider.js', import.meta.url))],
  bundle: true, format: 'iife', write: false,
}).outputFiles[0].text

it('preserves the existing provider and ignores stale refresh errors only while the replacement bridge is ready', () => {
  const handlers = []
  const existing = { getPublicKey: vi.fn() }
  const window = {
    nostr: existing, location: { origin: 'https://app.example' },
    addEventListener: (type, listener, capture) => handlers.push({ listener, capture }),
    postMessage: vi.fn(),
  }
  runInNewContext(provider, { window })
  expect(window.nostr).toBe(existing)
  expect(handlers[0].capture).toBe(true)
  expect(window.postMessage).toHaveBeenCalledWith({ type: 'bark-bridge-query' }, window.location.origin)
  const message = data => {
    const event = { source: window, origin: window.location.origin, data, stopImmediatePropagation: vi.fn() }
    handlers[0].listener(event)
    return event.stopImmediatePropagation
  }
  const stale = { type: 'bark-response', id: 1, error: 'Bark was updated. Please refresh the page.' }
  expect(message(stale)).not.toHaveBeenCalled()
  message({ type: 'bark-bridge-ready', token: 'replacement' })
  message({ type: 'bark-bridge-invalidated', token: 'old' })
  expect(message(stale)).toHaveBeenCalledOnce()
  expect(message({ ...stale, error: 'Request denied by user.' })).not.toHaveBeenCalled()
  message({ type: 'bark-bridge-invalidated', token: 'replacement' })
  expect(message(stale)).not.toHaveBeenCalled()
})

it('rejects outstanding page requests when extension reload invalidates the bridge', async () => {
  const handlers = []
  const window = {
    location: { origin: 'https://app.example' },
    addEventListener: (_type, listener) => handlers.push(listener),
    postMessage: vi.fn(),
  }
  const banner = { style: {}, appendChild: vi.fn(), addEventListener: vi.fn(), setAttribute: vi.fn() }
  const body = { appendChild: vi.fn() }
  const clear = vi.fn(clearTimeout)
  runInNewContext(provider, {
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

function waitingProvider() {
  const handlers = []
  const timers = new Map()
  let timerId = 0
  const window = {
    location: { origin: 'https://app.example' },
    addEventListener: (_type, listener) => handlers.push(listener),
    postMessage: vi.fn(),
  }
  const schedule = vi.fn((callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId })
  const clear = vi.fn(id => timers.delete(id))
  runInNewContext(provider, { window, document: {}, setTimeout: schedule, clearTimeout: clear })
  const message = data => handlers.forEach(listener => listener({ source: window, origin: window.location.origin, data }))
  return { window, timers, schedule, clear, message }
}

it('reserves a longer approval review without settling the request or allowing repeated extensions', async () => {
  const { window, timers, schedule, message } = waitingProvider()
  const request = window.nostr.getPublicKey()
  const [{ id }] = window.postMessage.mock.calls[0]
  message({ type: 'bark-approval-wait', id, waitMs: 2_520_000 })
  expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 2_520_000)
  message({ type: 'bark-approval-wait', id, waitMs: 2_520_000 })
  expect(schedule).toHaveBeenCalledTimes(2)
  message({ type: 'bark-response', id, result: 'fixture public key' })
  await expect(request).resolves.toBe('fixture public key')
  expect(timers.size).toBe(0)
})

it('rejects invalid approval wait values and keeps the page-side wait bounded', async () => {
  const { window, timers, schedule, message } = waitingProvider()
  const request = window.nostr.getPublicKey()
  const rejection = expect(request).rejects.toThrow('Bark request timed out.')
  const [{ id }] = window.postMessage.mock.calls[0]
  for (const waitMs of [NaN, Infinity, -1, 0, 2_520_001, '2520000']) message({ type: 'bark-approval-wait', id, waitMs })
  expect(schedule).toHaveBeenCalledTimes(1)
  const [{ callback }] = timers.values()
  callback()
  await rejection
})
