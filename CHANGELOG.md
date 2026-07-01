# Changelog

All notable changes to Bark are documented here.

## [Unreleased]

### Changed

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

### Added

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
