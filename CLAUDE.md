# CLAUDE.md — Bark

## What is Bark?

Minimal NIP-07 browser extension that bridges `window.nostr` to a remote NIP-46
signer. Works with any NIP-46 bunker; persona features require Heartwood.

## Build and test

```bash
npm install
npm run build      # esbuild → dist/
npm test           # vitest
npm run package    # build + zip for release
```

## Architecture

Five source files in `src/`:

| File | Role |
|------|------|
| `provider.js` | Injected into pages. Implements `window.nostr` API. Posts messages to content script. |
| `content-script.js` | Bridge. Relays postMessage ↔ chrome.runtime.sendMessage. Validates origin and structure. |
| `background.js` | Service worker. NIP-46 connection via nostr-tools BunkerSigner. Request routing, validation, error sanitisation, connection state. |
| `popup.js` | Popup UI. Two-tier rendering (Heartwood vs standard bunker), relay display, reconnection. |
| `popup.html` | Popup markup and styles. Dark theme, 320px wide. |

### Message flow

```
Web page → provider.js (postMessage) → content-script.js (chrome.runtime.sendMessage)
→ background.js (BunkerSigner → NIP-46 relay → Heartwood) → response back
```

### Message types (chrome.runtime)

- `bark-request` — NIP-07/NIP-44/Heartwood RPC call
- `bark-reset` — tear down connection (disconnect or URI change)
- `bark-status` — query connection state, relay health, Heartwood mode

## Conventions

- **British English** — colour, initialise, behaviour
- **No local key material** — the extension never touches private keys
- **Pure functions for testable logic** — parseMethod, validators, sanitiseError, buildHeartwoodArgs are all exported and unit tested
- **Commit messages** — `type: description` (feat:, fix:, test:, docs:)

## Key dependency

`nostr-tools` — provides `BunkerSigner`, `parseBunkerInput`, `SimplePool`, crypto utilities. Pinned at `^2.23.0`.
