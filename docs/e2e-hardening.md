# E2E Hardening Matrix

Bark has three useful test layers:

1. Unit tests for policy, validation, and pure storage helpers.
2. Contract tests for Heartwood-compatible HTTP hosts and bridge hosts.
3. Browser E2E tests for the packaged extension lifecycle.

The first two layers run in `npm test`. The initial browser smoke layer runs in
`npm run e2e:chromium`. Deeper browser tests should keep using a real browser
runner, because they need extension loading, popup pages, content scripts,
approval windows, and service worker wakeups.

## Contract Coverage

The `test/heartwood-http.e2e.test.js` suite runs against a real local HTTP
server and covers the Bark-facing API that Heartwood appliances, Pi daemons, and
bridge hosts expose:

- `POST /api/pair` approves Bark and returns the master bunker URI.
- `GET /api/identities` returns per-identity bunker URIs.
- Missing `/api/identities` falls back to the master bunker URI.
- Invalid bunker URIs are rejected before storage.

This is the critical crossover for cheap Wi-Fi-less hardware: Bark still talks
HTTP/NIP-46, while `heartwood-bridge` owns relay-to-serial transport.

## Browser E2E Coverage

Use Playwright with a persistent Chromium profile and the built `dist/`
extension loaded.

Implemented smoke scenarios:

- Extension loads and the popup opens from `dist/`.
- Content script injects `window.nostr` on a localhost test page.
- Unpaired `window.nostr.getPublicKey()` returns a safe user-facing error.
- Deterministic local NIP-46 relay/signer smoke seeds a `bunker://` URI with a
  localhost WebSocket relay and verifies `getPublicKey`, `getRelays`, and
  `signEvent` through the real extension/provider path.
- Approval popup smoke drives the real extension approval window and verifies
  deny, allow-once, trust-site persistence, trusted routine signing without a
  second popup, and protected kind 0 re-approval.
- Optional live relay/signer smoke pairs Bark by direct storage seeding and
  verifies `getPublicKey`, `getRelays`, and `signEvent` against a real
  configured bunker URI.

Run the live smoke only when a signer is already available over relays:

```bash
BARK_LIVE_BUNKER_URI='bunker://...' npm run e2e:live
```

The live smoke is not part of CI because it depends on external relays and
signer approval timing. The test disables Playwright traces/screenshots/video
for that file so bunker URI secrets are not captured in test artefacts.
Without `BARK_LIVE_CLIENT_SECRET`, the test generates a fresh Bark client key on
each run, so the signer may ask for client approval. Set
`BARK_LIVE_CLIENT_SECRET=<64-hex-secret>` to reuse an already approved test
client.

The live smoke uses the packaged `diagnostic.html` extension page to seed
storage, call internal runtime messages, and reset Bark during cleanup. That
keeps setup independent from popup startup behaviour and avoids exposing the
bunker URI in screenshots or traces.

The deterministic signer smoke is included in `npm run e2e:chromium` and can be
run on its own:

```bash
npm run e2e:deterministic
npm run e2e:approval
```

It runs entirely on loopback and has no real keys, public relays, signer
approval, or hardware dependency. These are the CI gates for the Bark-owned
NIP-46 extension path and approval policy surface. The live smoke remains the
manual proof that public relays and a real signer are reachable.

Next release-blocking scenarios:

- Popup pairs to a fake Heartwood HTTP host and imports two identities.
- Clicking a Heartwood identity switches the active Bark instance.
- A request after service worker idle reconnects instead of hanging.
- Direct Sapwood/bridge `bunker://` URI pairing does not request HTTP host
  permission.

Browser target smoke tests:

- Chromium/Chrome/Brave/Edge: load `dist/` with `npm run e2e:chromium`.
- Firefox: load `dist-firefox/` and verify the background script manifest path.
- Safari: convert `dist-safari/` with Apple's Safari Web Extension tooling and
  run a manual smoke until CI has a macOS/Safari runner.

## Live Device Verification

Last full run: 2026-07-16, against a physical heartwood-esp32 signer reached
over four public relays. Verified: connect (4-param metadata), getPublicKey,
signEvent via `window.nostr` (slot-policy auto-approve), NIP-44 round-trip,
keep-alive ping, Heartwood detection, and the persona lifecycle — derive,
list, switch by name, sign-as-persona, switch back — each behind a physical
button approval, plus the 30s button-timeout deny path surfacing cleanly to
the page.

To repeat: obtain the slot's `bunker://` URI, then

```bash
BARK_LIVE_BUNKER_URI='bunker://…' \
BARK_LIVE_CLIENT_SECRET=<64-hex, reuse across runs> \
npm run e2e:live
```

`heartwoodd --mode soft` (heartwood-esp32 repo) provides the same daemon
codebase without hardware: unlock, create a master and slot via its HTTP API,
allow `sign_event` on the slot with `auto_approve`, and point the same command
at the slot URI with a local relay.

## Out Of Scope For Bark

Bark should not test serial firmware directly. That belongs in Heartwood and
Sapwood:

- `heartwood-bridge`: relay-to-serial request/response and no-key/no-plaintext
  guarantees.
- Sapwood: USB provisioning, bridge slots, serial frame handling, and hardware
  setup UX.
- Firmware: button approval, policy enforcement, key storage, and serial
  transport.
