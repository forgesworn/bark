# Privacy Policy — Bark

**Last updated:** 2026-07-16

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
- **Signing policies** — per-site allow/ask/deny choices, per-method and
  per-kind overrides, protected event kind rules, and the privacy mode
  toggle.

These values stay on your machine in your browser's extension storage. The
bunker URI and client secret are used only to communicate with the signer
through the relays specified in your bunker URI. Nothing is transmitted to
the Bark developers; there is no server side.

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

Request payloads (events you ask to sign, text you ask to encrypt or decrypt)
are encrypted end to end with NIP-44 between Bark and your signer. Relay
operators see only ciphertext plus the transport metadata inherent to any
WebSocket connection: the two public keys involved, message timing, and your
IP address. Choose relays you are comfortable with; they are always yours to
change.

If you pair by QR (nostrconnect), Bark connects to the relay you enter for the
pairing handshake (the field defaults to `wss://relay.nsec.app`) using a fresh
key and secret generated for that attempt. If your signer requires a browser
approval step, Bark shows an "Open approval page" button; the signer-provided
https page opens in a new tab only when you click it.

If you pair by entering a Heartwood or bridge-host address, Bark sends local HTTP
requests to that address to pair and, when available, import Heartwood's
per-identity bunker URI manifest. For Wi-Fi-less hardware behind
`heartwood-bridge`, Bark does not communicate with the board over USB/serial;
the host daemon handles that transport.

With privacy mode enabled, Bark additionally hides `window.nostr` from every
site without a site rule, so unlisted sites cannot detect that the extension
is installed. This is a local behaviour switch; it involves no network
activity.

## Your keys

Bark never sees, stores, or handles your private key. All signing happens on
your remote signer or on hardware behind its bridge daemon. Bark only receives
signed events back.

## Questions

If you have questions about this policy, open an issue at
[github.com/forgesworn/bark](https://github.com/forgesworn/bark/issues).
