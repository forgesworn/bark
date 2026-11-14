// Pairing QR rendering for the popup. Error correction level L and a one
// module border, black on white, as the popup has always drawn it; the SVG
// carries a viewBox only, so the stylesheet sets the displayed size.

import { encode, toSvg } from '@forgesworn/qr'

export function renderQrSvg(text) {
  return toSvg(encode(text, { ecc: 'L' }), { margin: 1, dark: '#000', light: '#fff' })
}
