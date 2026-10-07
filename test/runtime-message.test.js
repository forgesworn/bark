import { it, expect, vi, afterEach } from 'vitest'
import { sendRuntimeMessageWithDeadline, isSignerRefusal } from '../src/runtime-message.js'

afterEach(() => vi.useRealTimers())

it.each(['callback', 'promise'])('bounds a silent %s worker without retrying', async (style) => {
  vi.useFakeTimers()
  const sendMessage = vi.fn(() => style === 'promise' ? new Promise(() => {}) : undefined)
  const api = { runtime: { sendMessage } }
  const pending = sendRuntimeMessageWithDeadline(style === 'callback' ? api : null,
    style === 'promise' ? api : null, { type: 'bark-request' }, 100)
  const rejected = expect(pending).rejects.toThrow('background request timed out')
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(sendMessage).toHaveBeenCalledOnce()
})

it('distinguishes explicit refusal from missing replies', () => {
  expect(isSignerRefusal('unauthorised')).toBe(true)
  expect(isSignerRefusal('Request denied')).toBe(true)
  expect(isSignerRefusal('Signer connection timed out.')).toBe(false)
})
