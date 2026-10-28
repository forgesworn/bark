// Explicit, bounded DTO for the trusted approval UI. Never expose generic params.
export const CRYPTO_PREVIEW_BYTES = 4096
const methods = new Set(['nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt', 'nip44.decrypt'])

function inputPreview(input) {
  let inputBytes = 0, previewBytes = 0, preview = '', complete = true
  for (const character of input) {
    const point = character.codePointAt(0)
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    inputBytes += bytes
    if (complete && previewBytes + bytes <= CRYPTO_PREVIEW_BYTES) {
      preview += character
      previewBytes += bytes
    } else complete = false
  }
  return { inputPreview: preview, inputBytes, previewBytes, complete }
}

export function prepareCryptoApproval(method, params) {
  if (!methods.has(method)) return null
  const inputType = method.endsWith('.encrypt') ? 'plaintext' : 'ciphertext'
  // Read once and copy primitive values. Preview and later execution share the
  // same immutable snapshot, even if the caller's object is subsequently changed.
  const peerPubkey = params?.pubkey, input = params?.[inputType]
  if (typeof peerPubkey !== 'string' || typeof input !== 'string') {
    throw new Error(`${method} requires pubkey and ${inputType}.`)
  }
  if (!/^[0-9a-f]{64}$/.test(peerPubkey)) throw new Error(`Invalid pubkey for ${method}.`)
  return Object.freeze({
    params: Object.freeze({ pubkey: peerPubkey, [inputType]: input }),
    preview: Object.freeze({ method, peerPubkey, inputType, ...inputPreview(input) }),
  })
}
