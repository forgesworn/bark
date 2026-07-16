# Changelog

All notable changes to Bark are documented here.

## [1.1.1] — 2026-07-16

### Fixed

- Heartwood identity methods (`heartwood_list_identities`, `heartwood_derive`,
  `heartwood_derive_persona`, `heartwood_switch`) now default to ask instead
  of falling through to deny, so Heartwood-aware web apps can request them
  with user approval. They remain excluded from trusted-site grants.
- The firmware's `unauthorised` error is now recognised as
  awaiting-client-approval alongside the older `not approved` phrasing.

### Verified

- The full feature surface was verified live against a physical
  heartwood-esp32 signer over public relays on 2026-07-16: NIP-07 core,
  NIP-44 both directions, keep-alive ping, Heartwood detection, and the
  complete persona lifecycle (derive, list, switch, sign-as-persona) with
  physical button approval, including the button-timeout deny path.

## [1.1.0] — 2026-07-16

### Added

- Client-initiated `nostrconnect://` pairing with QR code. Bark generates the
  URI (fresh client keypair and secret per attempt), the signer scans or
  receives it and connects back over the relay, and the connected signer is
  adopted live. Covered by a deterministic local-relay E2E.
- Signer `auth_url` handling: bunkers that require a browser approval step
  (e.g. nsec.app) now get an "Open approval page" button in the popup.
- Approval request queue: concurrent NIP-07 calls queue FIFO instead of
  failing with "an approval is already in progress". Toolbar badge shows the
  pending approval count.
- Policy action badges are click-to-cycle (allow → ask → deny), and site
  rules expand to show and edit per-site kind overrides.
- NIP-46 keep-alive pings hold the relay socket open for two minutes after
  the last request, so active browsing stops paying a reconnect per action.
- Release workflow: pushing a `v*` tag builds, tests, packages all three
  browser targets, and attaches the zips to a draft GitHub release.
- Store submission pack in `docs/store-listing.md`.

### Changed

- `provider.js` is injected as a declarative MAIN-world content script on
  Chromium and Firefox, removing the race where page scripts could observe
  `window.nostr` as undefined at document start. Safari keeps the script-tag
  fallback.
- The Chromium and Safari manifests declare no host permissions at all
  (WebSockets are not gated by host permissions on Chromium); HTTP pairing
  access remains optional and per-origin. Firefox keeps its declared relay
  permissions.
- Provider timeouts raised to 180s for `signEvent` and 120s otherwise, so
  queued approvals and hardware button presses don't time out at the page.
- The unconditional 2s pre-connect delay is removed; the connect retry loop
  recovers missed responses (deterministic E2E: 3.2s → 2.1s).
- Signers answering "unsupported method" to the Heartwood probe are no
  longer misdetected as Heartwood.

### Changed (hardening since 1.0.0)

- Default policies now ask before unknown sites can read identity, read relays,
  sign events, or use NIP-04/NIP-44 encryption methods.
- Approval popup now supports one-time approval or trusting a site for routine
  future requests.
- Trusted-site rules keep protected event kinds asking by default.
- NIP-46 connect metadata is now sent in the fourth `connect` parameter, with
  the requested-permissions slot left empty when unused.
- Runtime debug logging is gated behind a local debug flag.
- Stored policy data is migrated to the safer policy schema while preserving
  existing site and kind rules.
- HTTP/HTTPS host access for pairing is now optional and requested per entered
  pairing origin; relay WebSocket access remains a declared host permission.
- Localhost WebSocket relay access is declared for loopback bridge/signers and
  deterministic browser E2E.
- Heartwood identity switching now follows current Heartwood behavior: Bark
  imports per-identity bunker URIs and switches identities by switching Bark
  instances. `heartwood_switch` remains available only as a legacy RPC path.
- Documentation now covers the low-cost HSM path where `heartwood-bridge`
  provides relay-to-serial transport for Wi-Fi-less signer hardware.
- Optional Heartwood capability detection and relay health probes now have hard
  timeouts, so a standard NIP-46 signer that ignores Heartwood-specific methods
  cannot block normal signing.

### Added (hardening since 1.0.0)

- GitHub Actions CI for tests, build, audit, and package checks on Node 22 and
  Node 24.
- Browser-specific build/package targets for Chromium-family browsers, Firefox,
  and Safari.
- `npm run verify`, `npm run audit:prod`, `npm run build:all`, and
  `npm run package:all` scripts.
- Tests for trusted-site policy behavior, policy migration, sender-origin
  canonicalization, NIP-46 connect params, and Heartwood identity manifest
  imports.
- Heartwood/bridge HTTP contract tests backed by a real local HTTP server.
- E2E hardening matrix for browser lifecycle, approval popup, identity switching,
  and service worker reconnect coverage.
- Playwright Chromium smoke tests that load the packaged extension, open the
  popup, verify provider injection, and check the unpaired safe-error path.
- Optional live relay/signer Playwright smoke test for a real `bunker://`
  connection, gated by `BARK_LIVE_BUNKER_URI`.
- Deterministic local NIP-46 relay/signer Playwright smoke test that runs in CI
  without public relays, hardware, or real secrets.
- Approval popup Playwright smoke test covering deny, allow-once, trust-site
  persistence, and protected-kind re-approval through the real extension UI.
- Extension-internal diagnostics page for E2E storage seeding and runtime
  messaging without loading popup UI.

## [1.0.0] — 2026-04-07

### Added

- NIP-07 `window.nostr` interface (Manifest V3 Chrome extension)
- NIP-46 remote signing — works with any compliant bunker (nsecBunker, Amber, Heartwood)
- NIP-44 encrypt/decrypt forwarded to remote signer; no local cryptography
- Heartwood persona extensions via custom NIP-46 RPC methods:
  - `heartwood_list_identities` — list all derived identities on the device
  - `heartwood_derive(purpose, index)` — derive a new identity from the device mnemonic
  - `heartwood_switch(pubkey)` — switch the active signing identity
- Layered signing policy engine: allow/ask/deny evaluated per method, per event kind, per site
  - Default: ask for kind 0 (profile), kind 3 (contacts), kind 10002 (relay list)
  - Configurable per-site kind overrides
- Approval popup (420 × 520 px) for `ask`-policy requests; 60-second timeout
- Multi-instance support — connect to multiple bunkers and switch between them
- HTTP pairing flow for local Heartwood devices (`heartwood.local:3000`)
- Heartwood detection: probes `heartwood_list_identities` on connect; degrades gracefully to standard NIP-46 if unsupported
- Auto-reconnect with exponential backoff (5 s → 10 s → 30 s → 60 s) for MV3 service worker lifecycle
- Storage migration from legacy single-connection format to multi-instance format
- Error sanitisation: internal relay URLs, stack traces, and connection details never exposed to web pages
- Origin validation in content script; request IDs validated as positive integers
- Stale-extension banner when the extension reloads mid-request (Chrome update, manual reload)
- Unit tests for policy engine and background service worker helpers via Vitest
