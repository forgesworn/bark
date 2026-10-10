# Bark — Browser gate

Approved direction: Browser gate, 10 October 2026.

The browser frame and keyhole represent the doorway to a remote signer.
The logo describes access to signing; Bark never holds private keys.

Canonical editable artwork: `bark/src/icons/bark.svg` (100 × 100 viewBox).
This folder and `forgesworn.dev/map/icons/bark.svg` carry matching copies.

| Colour | Hex | Use |
| --- | --- | --- |
| Forest | #123B32 | Rounded tile |
| Ivory | #FAF7ED | Browser frame |
| Mint | #6FBF8B | Keyhole |
| Gold | #C9A962 | Ring and browser dots |

Keep the square proportions and built-in clear space. Use the complete tile
on light and dark backgrounds. Use a separate “Bark” wordmark beside it.

Run `npm run brand:build` in Bark to regenerate extension PNGs, site assets
and the store icon. At 16px the ring and two small browser dots are omitted
for clarity; the browser frame and keyhole remain unchanged.
Run `npm run build:all`, then `node scripts/store-screenshots.mjs` to refresh
the store screenshots and promotional artwork. The screenshot script also refreshes
`site/assets/` and the website approval image. Run `npm run map` in forgesworn.dev after
updating the map icon.
