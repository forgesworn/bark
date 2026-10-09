import { describe, it, expect } from 'vitest'
import { normaliseApprovalTimeout, approvalQueueTimeout, approvalExpired, MAX_APPROVAL_WAIT_MS } from '../src/approval-timing.js'

describe('approval review deadlines', () => {
  it('supports a tenfold adjustment and defaults invalid stored settings safely', () => {
    for (const value of [60_000, 300_000, 600_000]) expect(normaliseApprovalTimeout(value)).toBe(value)
    for (const value of [undefined, null, '600000', Infinity, NaN, -1, 59_999, 600_001]) expect(normaliseApprovalTimeout(value)).toBe(60_000)
    expect(MAX_APPROVAL_WAIT_MS).toBe(2_520_000)
  })

  it('gives queued requests the same tenfold timing adjustment', () => {
    expect(approvalQueueTimeout(60_000)).toBe(180_000)
    expect(approvalQueueTimeout(300_000)).toBe(900_000)
    expect(approvalQueueTimeout(600_000)).toBe(1_800_000)
    expect(approvalQueueTimeout(Infinity)).toBe(180_000)
  })

  it('rejects an expired approval even if the expiry timer has not run', () => {
    expect(approvalExpired({ expiresAt: 100 }, 99)).toBe(false)
    expect(approvalExpired({ expiresAt: 100 }, 100)).toBe(true)
    expect(approvalExpired({ expiresAt: 100 }, 101)).toBe(true)
    for (const entry of [undefined, null, {}, { expiresAt: Infinity }, { expiresAt: NaN }]) expect(approvalExpired(entry, 99)).toBe(true)
  })
})
