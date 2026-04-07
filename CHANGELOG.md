# Changelog

All notable changes to Bark are documented here.

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
- 92 unit tests (policy engine and background service worker) via Vitest
