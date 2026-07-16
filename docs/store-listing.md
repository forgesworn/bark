# Store listing pack

Everything needed to submit Bark to the Chrome Web Store and Firefox
Add-ons (AMO). Keep this in sync with the manifest and README.

## Identity

- **Name:** Bark
- **Category:** Productivity (CWS) / Other (AMO)
- **Single purpose:** NIP-07 signing provider for Nostr web apps, backed by a
  remote NIP-46 signer. No keys are stored in the browser.
- **Privacy policy URL:** https://github.com/forgesworn/bark/blob/main/PRIVACY.md
- **Homepage:** https://github.com/forgesworn/bark

## Short description (CWS, max 132 chars)

> Sign Nostr events with your keys held on a remote signer. NIP-07 for web
> apps, NIP-46 underneath. No keys in the browser.

## Long description

Bark bridges `window.nostr` to a remote NIP-46 signer, so Nostr web apps can
request signatures without your private key ever entering the browser.

- Works with any NIP-46 bunker: nsecBunker, Amber, nsec.app, Heartwood, or
  your own signer
- Pair by pasting a bunker:// URI, scanning a QR (nostrconnect), or a local
  Heartwood HTTP address
- Per-site approval with allow/ask/deny policies, per-kind rules, and
  protected event kinds (profile, contacts, relay list)
- Approval requests queue with a toolbar badge; nothing signs without your say
- NIP-04 and NIP-44 encryption forwarded to the signer
- Multiple signer instances with one-click switching; Heartwood devices add
  unlimited derived identities
- Privacy mode: hide Bark from every site except the ones you whitelist, so
  pages cannot fingerprint that a Nostr extension is installed
- Localised into 53 languages
- Minimal footprint: the only Chrome permission is `storage` — no tabs
  access, no remote code, no analytics, no tracking, no accounts, no wallet

## Permissions justification (reviewer notes)

| Permission | Why |
|---|---|
| `storage` | Persists signer connection details (bunker URI, client auth key), site policies, and connection health locally. Nothing leaves the machine except NIP-46 relay traffic to the user's own signer. |
| `optional_host_permissions` http/https | Requested only when the user pairs with a local Heartwood/bridge device by HTTP address (e.g. `heartwood.local:3000`). Never requested otherwise. |
| Content scripts on `https://*/*` | NIP-07 requires injecting the `window.nostr` provider so Nostr web apps can request signatures. The isolated content script validates origin and message shape before anything reaches the service worker. |

Firefox additionally declares `wss://*/*` and loopback `ws://` host
permissions for relay WebSockets (user-optional under MV3). The Chromium
build needs no host permissions for WebSockets.

No remote code: all scripts are bundled; the CSP is `script-src 'self'`.

## AMO reviewer build instructions

Bundled code is built from source in this repository:

```bash
# Node 22 or 24
npm ci
npm run build:firefox   # output in dist-firefox/
```

`npm run package:firefox` produces the exact submitted zip.

`web-ext lint` reports 0 errors. The remaining UNSAFE_VAR_ASSIGNMENT
warnings are innerHTML assignments whose dynamic values all pass through
the local `escapeHtml` helper first.

## Positioning

The nearest competitor is Bunker46 (same NIP-07 → NIP-46 bridge; Vue/WXT;
companion to the self-hosted Bunker46 server). On both stores (~107 CWS
users, 1 AMO, 0 reviews), last updated 2026-04. It has bunker URI +
nostrconnect QR pairing, multi-profile, per-domain/per-method permissions,
NIP-04/44, a privacy whitelist mode, and 44 locales.

Where Bark leads — make these visible in the listing without naming them:

- **Permissions**: Bunker46 requests `storage + tabs (+ windows)`; Bark's
  Chromium build requests only `storage`. Lead with this bullet.
- **Policy depth**: event-kind-level rules and protected kinds (0, 3,
  10002) with per-site overrides; Bunker46 stops at domain/method level.
- **Injection correctness**: MAIN-world declarative content script — no
  `window.nostr`-undefined race; Bunker46 uses script-tag injection via
  web-accessible resources.
- **UX under load**: approval queue with badge count, keep-alive pings,
  `auth_url` handling for nsec.app-style bunkers.
- **Hardware**: Heartwood personas, HTTP pairing for local signers, live
  verification against physical hardware; plus a Safari build ready.

Both former gaps are closed as of v1.2.0:

- Privacy mode (popup → Signing Policies) exposes `window.nostr` only to
  origins with a site rule; hidden origins get silence, not errors, so the
  extension cannot be fingerprinted. Enforced in the content script and
  covered by e2e.
- Bark ships 53 locales (`src/_locales/`), against Bunker46's 44. Missing
  keys in a locale fall back to English automatically.

## Assets checklist

- [x] Screenshots (1280×800) in `docs/store-assets/` — regenerate with
      `npm run build && node scripts/store-screenshots.mjs`
- [x] CWS allows **max 5 screenshots** — upload these, in this order:
      `03-connected`, `06-approval`, `04-policies`, `02-qr-pairing`,
      `05-personas`. Omit `01-setup` (a subset of `02-qr-pairing`).
      AMO allows up to 10 — upload all six there.
- [x] CWS promo tile 440×280 (`docs/store-assets/promo-tile-440x280.png`)
- [x] CWS store icon (`docs/store-assets/store-icon-128.png`) — 96×96
      artwork centred on a transparent 128×128 canvas per Google's image
      guidelines; the raw `src/icons/bark-128.png` is full-bleed and will
      be rejected

## Submission checklist

- [ ] `npm run verify && npm run e2e:chromium` green
- [ ] Version bumped in `package.json` + `src/manifest.json`
- [ ] CHANGELOG entry dated
- [ ] Tag `vX.Y.Z` pushed (release workflow attaches zips)
- [ ] CWS: upload `bark-vX.Y.Z.zip`, fill permissions justification from above
- [ ] AMO: upload `bark-firefox-vX.Y.Z.zip` + source zip, reviewer notes from above
- [ ] Safari: convert `dist-safari/` via Xcode when targeting the App Store
