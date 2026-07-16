+# Store listing pack

Everything needed to submit Bark to the Chrome Web Store and Firefox
Add-ons (AMO). Keep this in sync with the manifest and README.

## Identity

- **Name:** Bark
- **Category:** Productivity (CWS) / Other (AMO)
- **Single purpose:** NIP-07 signing provider for Nostr web apps, backed by a
  remote NIP-46 signer. No keys are stored in the browser.
- **Privacy policy URL:** https://github.com/forgesworn/bark/blob/main/PRIVACY.md
- **Homepage:** https://bark.forgesworn.dev (marketing site; source in `site/`,
  deployed by the Pages workflow on push to main)
- **Support URL:** https://bark.forgesworn.dev/support.html (common fixes,
  issues/discussions links, private security contact)

## Short description (CWS, max 132 chars)

> Sign Nostr events with your keys held on a remote signer. NIP-07 for web
> apps, NIP-46 underneath. No keys in the browser.

## Long description

CWS allows up to 16,000 characters and preserves line breaks (no markdown).
Paste the block below verbatim.

```
Bark bridges window.nostr to a remote NIP-46 signer, so Nostr web apps can request signatures without your private key ever entering the browser. Your keys stay on your signer: a Heartwood hardware device, your own self-hosted bunker (such as heartwoodd), or a hosted service like nsec.app. Only signatures cross the wire.

NO KEYS IN THE BROWSER. EVER.
Bark never generates, stores, or touches private key material. There is no key import, no seed phrase screen, and nothing for a malicious page or a browser compromise to steal. Every signing and encryption request travels over the encrypted NIP-46 protocol to a signer you control, and only the result comes back.

WORKS WITH ANY NIP-46 BUNKER
Bark is a standard NIP-07 provider backed by standard NIP-46. It works with Heartwood, heartwoodd, nsecBunker, Amber, nsec.app, and any other compliant signer. Three ways to pair:
• Paste a bunker:// URI from any signer.
• Pair by QR: Bark generates a nostrconnect:// URI and QR code with a fresh key and secret per attempt; scan it with your signer and it connects back over the relay. Signers that need a browser approval step (such as nsec.app) get an "Open approval page" button.
• Enter a local Heartwood device address for HTTP pairing.

NOTHING SIGNS WITHOUT YOUR SAY
The first time a site asks for your identity, a signature, or encryption, Bark asks you. Allow the request once, trust the site for routine signing, or deny it. Sensitive event kinds (your profile, contact list, and relay list) keep asking even on trusted sites unless you explicitly override them. Concurrent requests queue in order with a toolbar badge instead of failing.

POLICY CONTROL DOWN TO METHOD AND EVENT KIND
The policy editor gives every site an allow/ask/deny rule, and each rule can override individual methods (for example, deny nip44.decrypt on one site while allowing signing) and individual event kinds. Sensible defaults protect newcomers; full control is there when you want it.

PRIVACY MODE
Turn on privacy mode and Bark reveals window.nostr only to sites you have a rule for. Every other page sees nothing: no provider object, no error responses, no way to fingerprint that a Nostr extension is installed.

HEARTWOOD IDENTITIES
Paired with a Heartwood signer, Bark lists, derives, and switches unlimited identities derived from a single seed, each with its own keys. Post as different personas without ever exposing a key. With any other bunker, Bark works as a clean single-identity signer.

Bark is the browser end of the family. On Android, Cambium registers as a NIP-55 signer and proxies requests to the same Heartwood, so Amethyst, Primal, and friends sign through your device too. Sapwood manages the signer itself.

ENCRYPTION SUPPORT
NIP-44 and legacy NIP-04 encrypt/decrypt are forwarded to your signer, so DMs and encrypted app data work everywhere your signer does.

BUILT TO STAY OUT OF THE WAY
• Multiple signer instances with one-click switching.
• Keep-alive pings hold the relay connection open while you browse, so actions stay fast.
• Provider injected before page scripts run: apps never see window.nostr as undefined.
• Localised into 53 languages.

MINIMAL FOOTPRINT
Bark requests no blanket access to your browsing. Out of the box its content script runs only on a named list of popular Nostr clients; any other site gets access the moment you click Enable in the popup, one origin at a time, revocable just as easily. No browsing history, no remote code, no analytics, no tracking, no accounts, no wallet. The script reads nothing from the pages you visit and sends nothing anywhere except NIP-46 traffic to your own signer. The extension is fully open source (MIT) at github.com/forgesworn/bark, with a CI-tested build you can reproduce yourself.

Bark is the protective outer layer of Heartwood, the ForgeSworn open-source hardware signer, and works just as well without it.
```

## Permissions justification (reviewer notes)

| Permission | Why |
|---|---|
| `storage` | Persists signer connection details (bunker URI, client auth key), site policies, enabled-site list, and connection health locally. Nothing leaves the machine except NIP-46 relay traffic to the user's own signer. |
| `scripting` | Registers the NIP-07 provider content scripts for origins the user explicitly enables from the popup, and injects them into the invoking tab so the site works without a reload. Never used to read or modify page content. |
| `activeTab` | Lets the popup show which site the user is on so they can enable Bark for it, and covers the immediate injection into that tab after they click Enable. No tab data is used beyond the origin shown to the user. |
| `optional_host_permissions` http/https | Requested one origin at a time: when the user clicks Enable for a site, or pairs a local Heartwood/bridge device by HTTP address. Never requested wholesale. |
| Content scripts (curated list) | Baked-in matches for twelve well-known Nostr web clients plus localhost, so Bark works out of the box where most users need it, with no broad host access. |

CWS's "Host permission justification" field counts content-script match
patterns as host permissions. Paste this:

> Bark requests no broad host access. Its content scripts are baked in only
> for a fixed list of well-known Nostr web clients named in the manifest
> (snort.social, primal.net, iris.to, coracle.social, nostrudel.ninja,
> jumble.social, yakihonne.com, habla.news, zap.stream, njump.me,
> nostter.app, satellite.earth) plus localhost for local development. Bark
> is a NIP-07 signing provider and these sites need the window.nostr object
> injected before their scripts run. For any other site, the user clicks
> Enable in the popup: Bark then requests an optional host permission for
> that single origin, registers the same two scripts for that origin only,
> and activeTab covers the tab the user invoked. The scripts read nothing
> from pages and transmit nothing except the user's own signing requests to
> their configured signer over encrypted NIP-46. An optional privacy mode
> can further hide Bark from any site without an explicit rule.

Firefox additionally declares `wss://*/*` and loopback `ws://` host
permissions for relay WebSockets (user-optional under MV3). The Chromium
build needs no host permissions for WebSockets.

## Data usage (CWS Privacy tab)

Tick **none** of the nine data categories. Bark collects nothing: all state
(bunker URI, client secret, policies) is stored locally and never
transmitted off the device except as NIP-46 traffic to the user's own
signer, encrypted end to end, at the user's direction. That is the item's
single purpose, not data collection. (The bunker URI is credential-like but
never leaves the machine other than to authenticate to the user's own
signer, so "Authentication information" is not collected under CWS's
definition of transmission off-device for collection purposes.)

Certify all three disclosures — each is true:

- No sale/transfer to third parties apart from approved use cases ✓
- No use/transfer unrelated to the single purpose ✓
- No use/transfer for creditworthiness or lending ✓

Privacy policy URL: https://github.com/forgesworn/bark/blob/main/PRIVACY.md
(updated 2026-07-16 to cover QR pairing, auth_url, end-to-end encryption of
request payloads, relay transport metadata, and privacy mode — keep it in
step with any future data-flow change).

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

- **Permissions**: Bunker46 requests `storage + tabs (+ windows)` and runs
  its scripts on every website; Bark's Chromium build has no broad host
  access at all — a curated site list plus one-origin-at-a-time opt-in.
  Lead with this bullet.
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

- [x] Five captioned screenshots (1280×800) in `docs/store-assets/` —
      regenerate with `npm run build && node scripts/store-screenshots.mjs`.
      Each pairs a 2x UI capture with a headline explaining the feature.
      Upload in numbered order on both stores: `01-connected`,
      `02-approval`, `03-policies`, `04-qr-pairing`, `05-personas`.
- [x] CWS promo tile 440×280 (`docs/store-assets/promo-tile-440x280.jpg`,
      JPEG — the store rejects PNGs with an alpha channel)
- [x] CWS marquee promo tile 1400×560
      (`docs/store-assets/marquee-promo-1400x560.jpg`)
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
