# Privacy Policy — Bark

**Last updated:** 2026-04-01

## What Bark stores

Bark stores two items in local extension storage (`chrome.storage.local`):

- **Bunker URI** — the NIP-46 connection string you provide, containing your
  signer's public key and relay URLs.
- **Client secret** — a randomly generated key used to authenticate Bark to your
  signer across sessions. This is not your private key.

Both values stay on your machine, in Chrome's extension storage. They are never
transmitted anywhere except to the relays specified in your bunker URI.

## What Bark does not do

- **No data collection.** Bark does not collect, store, or transmit analytics,
  telemetry, usage data, or personal information.
- **No third-party services.** Bark makes no network requests except WebSocket
  connections to the Nostr relays specified in your bunker URI.
- **No tracking.** No cookies, no fingerprinting, no identifiers.

## Network connections

Bark connects via WebSocket to the relay URLs embedded in your bunker URI. These
connections carry NIP-46 signing requests between Bark and your remote signer.
No other network connections are made.

## Your keys

Bark never sees, stores, or handles your private key. All signing happens on
your remote signer (e.g. Heartwood). Bark only receives signed events back.

## Questions

If you have questions about this policy, open an issue at
[github.com/forgesworn/bark](https://github.com/forgesworn/bark/issues).
