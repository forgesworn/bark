import { describe, it, expect } from 'vitest'
import { createPacedAmoFetch } from '../scripts/amo-artwork-http.mjs'

describe('AMO listing write pacing', () => {
  it('paces writes while permitting immediate reads', async () => {
    let time = 0
    const waits = []
    const client = createPacedAmoFetch({
      fetchImpl: async () => new Response('{}'), now: () => time,
      sleep: async ms => { waits.push(ms); time += ms },
    })
    await client('https://example.test', { method: 'POST' })
    await client('https://example.test', { method: 'GET' })
    await client('https://example.test', { method: 'DELETE' })
    expect(waits).toEqual([30_000])
  })
  it('honours Retry-After only for an explicit rejection', async () => {
    let calls = 0, time = 0
    const waits = []
    const client = createPacedAmoFetch({
      fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '72' } }) : new Response('{}'),
      now: () => time, sleep: async ms => { waits.push(ms); time += ms },
    })
    expect((await client('https://example.test', { method: 'POST' })).status).toBe(200)
    expect(calls).toBe(2)
    expect(waits).toEqual([72_000])
  })
  it('never replays a mutation whose network response was lost', async () => {
    let calls = 0
    const client = createPacedAmoFetch({ fetchImpl: async () => { calls++; throw new Error('network') } })
    await expect(client('https://example.test', { method: 'POST' })).rejects.toThrow('network')
    expect(calls).toBe(1)
  })
  it('bounds repeated rate-limit responses', async () => {
    let calls = 0
    const client = createPacedAmoFetch({ fetchImpl: async () => { calls++; return new Response('', { status: 429 }) }, sleep: async () => {} })
    expect((await client('https://example.test', { method: 'POST' })).status).toBe(429)
    expect(calls).toBe(4)
  })
})
