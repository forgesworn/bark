import { schnorr } from '@noble/curves/secp256k1.js'

// Bounded Heartwood v1 hand-off. Bark never decrypts or exports child material.
export const PROVISION_METHOD = 'heartwood_provision_rendezvous'
const FIELDS = ['v', 'expectedPersona', 'targetDevice', 'index', 'nonce', 'expiresAt']
const ENVELOPE = ['v', 'p', 'd', 'rz', 'u', 'i', 'n', 'e', 'c']
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const xonly = value => {
  if (!hex(value)) return false
  try { schnorr.utils.lift_x(BigInt('0x' + value)); return true } catch { return false }
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))

export function validateProvisionRequest(value, now = Math.floor(Date.now() / 1000)) {
  if (!exact(value, FIELDS) || value.v !== 1 || !xonly(value.expectedPersona) || !xonly(value.targetDevice) ||
      !Number.isInteger(value.index) || value.index < 0 || value.index > 0xffffffff ||
      typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(value.nonce) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 600) {
    throw new Error('Invalid rendezvous provisioning request.')
  }
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, value[key]])))
}

export function provisionArgs(request) {
  const value = validateProvisionRequest(request)
  // Heartwood's parser requires JSON numbers, unlike ordinary NIP-46 methods.
  return [value.targetDevice, value.index, value.nonce, value.expiresAt]
}

export function validateProvisionResponse(raw, request, now = Math.floor(Date.now() / 1000)) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) throw new Error('Invalid rendezvous provisioning response.')
  let value
  try { value = JSON.parse(raw) } catch { throw new Error('Invalid rendezvous provisioning response.') }
  if (!exact(value, ENVELOPE) || value.v !== 1 || value.p !== request.expectedPersona ||
      value.d !== request.targetDevice || !xonly(value.rz) || value.u !== 'rendezvous' ||
      value.i !== request.index || value.n !== request.nonce || value.e !== request.expiresAt || value.e <= now ||
      typeof value.c !== 'string' || value.c.length < 132 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.c)) {
    throw new Error('Invalid rendezvous provisioning response.')
  }
  return raw // Preserve the encrypted envelope bytes, never JSON.parse for the caller.
}

export function isProvisionOrigin(origin) {
  try {
    const url = new URL(origin)
    return url.origin === origin && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}
