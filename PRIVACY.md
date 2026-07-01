# Privacy Policy — Bark

**Last updated:** 2026-07-01

## What Bark stores

Bark stores local extension state in the browser extension local storage API
(`chrome.storage.local` or the equivalent WebExtensions API):

- **Bunker URI** — the NIP-46 connection string you provide, containing your
  signer's public key and relay URLs.
- **Client secret** — a randomly generated key used to authenticate Bark to your
  signer across sessions. This is not your private key.
- **Instance metadata** — display name, pairing address, npub, Heartwood mode,
  Heartwood identity labels/pubkeys, active instance ID, and signer health
  status.
- **Signing policies** — per-site allow/ask/deny choices and protected event
  kind rules.

These values stay on your machine in your browser's extension storage. The
bunker URI and client secret are used only to communicate with the signer
through the relays specified in your bunker URI.

## What Bark does not do

- **No data collection.** Bark does not collect, store, or transmit analytics,
  telemetry, usage data, or personal information.
- **No third-party services.** Bark makes no network requests except WebSocket
  connections to the Nostr relays specified in your bunker URI, including
  loopback relay URLs if you paste or pair one, and optional HTTP pairing
  requests to the Heartwood or bridge-host address you enter.
- **No tracking.** No cookies, no fingerprinting, no identifiers.

## Network connections

Bark connects via WebSocket to the relay URLs embedded in your bunker URI. These
can be public `wss://` relays or local loopback `ws://localhost`/`ws://127.0.0.1`
relays exposed by a bridge daemon. These connections carry NIP-46 signing
requests between Bark and your remote signer.
If you pair by entering a Heartwood or bridge-host address, Bark sends local HTTP
requests to that address to pair and, when available, import Heartwood's
per-identity bunker URI manifest. For Wi-Fi-less hardware behind
`heartwood-bridge`, Bark does not communicate with the board over USB/serial;
the host daemon handles that transport.

## Your keys

Bark never sees, stores, or handles your private key. All signing happens on
your remote signer or on hardware behind its bridge daemon. Bark only receives
signed events back.

## Questions

If you have questions about this policy, open an issue at
[github.com/forgesworn/bark](https://github.com/forgesworn/bark/issues).
