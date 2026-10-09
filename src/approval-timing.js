// User-controlled review time is separate from signer/network timeouts.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000
export const MAX_APPROVAL_TIMEOUT_MS = 600_000
export const APPROVAL_QUEUE_TIMEOUT_MS = 180_000
export const APPROVAL_RESPONSE_GRACE_MS = 120_000
export const MAX_APPROVAL_WAIT_MS = approvalQueueTimeout(MAX_APPROVAL_TIMEOUT_MS) + MAX_APPROVAL_TIMEOUT_MS + APPROVAL_RESPONSE_GRACE_MS

export function normaliseApprovalTimeout(value) {
  return [60_000, 300_000, 600_000].includes(value) ? value : DEFAULT_APPROVAL_TIMEOUT_MS
}

// Scale the waiting queue too, so a longer review of the current request does
// not cause subsequent requests to expire at the old three-minute deadline.
export function approvalQueueTimeout(reviewTimeout) {
  return APPROVAL_QUEUE_TIMEOUT_MS * (normaliseApprovalTimeout(reviewTimeout) / DEFAULT_APPROVAL_TIMEOUT_MS)
}

export function approvalExpired(entry, now = Date.now()) {
  return !entry || !Number.isFinite(entry.expiresAt) || now >= entry.expiresAt
}
