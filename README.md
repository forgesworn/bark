# Bark

[![GitHub Sponsors](https://img.shields.io/github/sponsors/TheCryptoDonkey?logo=githubsponsors&color=ea4aaa&label=Sponsor)](https://github.com/sponsors/TheCryptoDonkey)

**[bark.forgesworn.dev](https://bark.forgesworn.dev)** · The protective outer layer of [Heartwood](https://github.com/forgesworn/heartwood).

Bark is a minimal NIP-07 browser extension that signs Nostr events through a remote signer via NIP-46. No keys in the browser. No accounts. No bloat.

## What it does

- **Signs Nostr events** via NIP-46 remote signing (NIP-07 interface for web apps)
- **Works with any NIP-46 bunker**: Heartwood, heartwoodd, nsecBunker, Amber, nsec.app, or your own signer
- **Switches Heartwood identities**: imports Heartwood's per-identity bunker URIs and switches by selecting the right bunker instance
- **Bridge-friendly**: works with Wi-Fi devices, Heartwood daemons, or relay-to-serial bridges for tethered low-cost hardware
- **Self-sovereign**: keys live on your signer hardware, never touch the browser
- **Privacy mode**: optionally hide `window.nostr` from every site except the ones you whitelist, so pages cannot fingerprint the extension
- **Speaks your language**: the UI ships in 53 locales

## What it doesn't do

- No wallet, no Lightning, no zaps
- No local key storage
- NIP-44 encrypt/decrypt forwarded to remote signer

## Install

1. Download the package for your browser from the [latest GitHub release](https://github.com/forgesworn/bark/releases/latest)
2. Extract the zip
3. Open `chrome://extensions/`, enable Developer mode
4. Click "Load unpacked", select the extracted directory
5. Click the Bark icon, enter a Heartwood/bridge address or paste your bunker URI

### Build from source

```bash
git clone https://github.com/forgesworn/bark.git
cd bark && npm install && npm run build:all
```

Then load the relevant output:

- Chromium, Chrome, Brave, Edge: `dist/`
- Firefox: `dist-firefox/`
- Safari: `dist-safari/` through Apple's Safari Web Extension conversion flow

Package all browser builds with:

```bash
npm run package:all
```

Run the release checks with:

```bash
npm run verify
npm run e2e:chromium
npm run e2e:deterministic
npm run e2e:approval
```

`npm run e2e:chromium` includes the deterministic local NIP-46 relay/signer
smoke and approval popup flow. `npm run e2e:deterministic` runs only that
CI-friendly signer path. `npm run e2e:approval` runs only the deny,
allow-once, trust-site, and protected-kind approval checks.

Run an optional live relay/signer smoke with a real approved bunker URI:

```bash
BARK_LIVE_BUNKER_URI='bunker://...' npm run e2e:live
```

That test seeds Bark with the bunker URI directly, trusts only its temporary
localhost test origin, then verifies `getPublicKey`, relay visibility, and a
real `signEvent` through the connected signer.
Set `BARK_LIVE_CLIENT_SECRET=<64-hex-secret>` as well if you want the signer to
remember the same Bark test client across runs.

### Full setup guide

For a complete walkthrough (firmware, bridge, provisioning, and Bark together), see the [Heartwood + Bark setup guide](docs/setup-guide.md).

For the release hardening test matrix, see [E2E hardening](docs/e2e-hardening.md).

## Works with any NIP-46 bunker

Bark works as a standard NIP-07 provider with any NIP-46 bunker. The signing flow (`getPublicKey`, `signEvent`, `nip44.encrypt`, `nip44.decrypt`) works identically regardless of the backend. Three ways to pair:

- **Paste a `bunker://` URI** from nsecBunker, Amber, nsec.app, or any compliant signer.
- **Pair by QR (nostrconnect)**: Bark generates a `nostrconnect://` URI and QR code; scan it with your signer (or paste it in) and the signer connects back over the relay. Signers that require a browser approval step (e.g. nsec.app) get an "Open approval page" button in the popup.
- **Heartwood HTTP address** for local devices (e.g. `heartwood.local:3000`). This targets the legacy Pi web UI's `/api/pair` contract; current `heartwoodd` deployments pair by bunker URI or QR instead, with the URI fetched from Sapwood or `GET /api/slots/{master}/{slot}/uri`.

Identity features (derive and list) require [Heartwood](https://github.com/forgesworn/heartwood). When you pair by a Heartwood HTTP address, Bark also imports the per-identity bunker URI manifest from `/api/identities`. That endpoint can be a Wi-Fi Heartwood appliance, a Pi daemon, or another Heartwood-compatible host sitting in front of cheap tethered hardware. The current Heartwood model is that each identity has its own bunker URI, and selecting a persona in Bark selects the matching bunker instance.

Sapwood-created bunker slots work by pasting their `bunker://` URI into Bark. Heartwood remains the signer source of truth; Bark only stores the approved connection strings and the Bark client auth secret.

## Cheap hardware and bridge mode

For hardware without Wi-Fi, Bark should not talk to the board directly. The
`heartwood-bridge` daemon is the network-facing NIP-46 component: it connects to
relays, pumps encrypted requests over USB/serial, and republishes the signed
responses. The bunker URI can point at public `wss://` relays or a loopback
`ws://localhost` relay exposed by the host daemon. Sapwood provisions and
manages that hardware path; Bark consumes the resulting `bunker://` URI or the
HTTP pairing API exposed by the host daemon.

That keeps the boundary clean:

- Cheap board: holds keys and signs.
- Bridge daemon: relay-to-serial transport, no signing key material.
- Sapwood: provisioning, slots, policies, and management.
- Bark: browser NIP-07 provider and bunker selector.

## Site trust and approvals

Bark asks before sharing identity, signing, or encrypting/decrypting for an
unknown site. The approval popup can allow a request once or trust the site for
routine future requests. Protected event kinds such as profile metadata,
contacts, and relay lists continue to ask unless you add an explicit site kind
override in the popup policy settings. Each site rule can also override
individual methods (for example, deny `nip44.decrypt` on one site while
allowing signing), and privacy mode hides Bark entirely from sites without a
rule.

## Heartwood RPC extensions

When connected to a Heartwood signer, Bark uses custom NIP-46 RPC methods for persona management. These are sent via `BunkerSigner.sendRequest()` over standard NIP-46 relay communication.

### `heartwood_list_identities`

Returns all derived identities on the device.

- **Params:** none
- **Returns:** `Array<{ pubkey: string, name?: string, purpose?: string }>`

### `heartwood_derive`

Derive a new identity from the device's mnemonic.

- **Params:** `[purpose: string, index: string]`
  - `purpose`: alphanumeric label, 1-64 chars (e.g. `"nostr"`, `"twitter"`)
  - `index`: derivation index as string, `"0"` to `"1000"`
- **Returns:** `{ pubkey: string, purpose: string, index: number }`

### `heartwood_switch` (legacy)

Latest Heartwood treats identity selection as per-connection, based on the `bunker://<pubkey>` target. Bark keeps this RPC available for older Heartwood builds and third-party callers, but the extension UI switches identities by switching Bark instances.

- **Params:** `[pubkey: string]`, a 64-char lowercase hex public key
- **Returns:** Heartwood-specific status for the current connection

## Comparison with other NIP-07 signers

| | Bark | Alby | nos2x | Bunker46 | Remote NIP-07 |
|---|---|---|---|---|---|
| Key storage | None (remote signer) | Browser or Alby Hub | Browser | None (remote signer) | None (Amber) |
| NIP-46 backend | Any bunker | No | No | Any bunker | Amber only |
| Pairing | bunker://, QR (nostrconnect), Heartwood HTTP | n/a | n/a | bunker://, QR | Amber QR |
| Approval model | Per-site allow/ask/deny, per-method and per-kind overrides, protected kinds, request queue | Per-site prompts | Per-site prompts | Per-domain, per-method | Per-request |
| Hide from unlisted sites | Yes (privacy mode) | No | No | Yes (whitelist) | No |
| Derived identities | Unlimited (Heartwood) | None | None | None | None |
| Hardware signer path | Yes (bridge to tethered boards) | No | No | No | Phone |
| Host permissions (Chromium) | None | Broad | None | Varies | None |
| Languages | 53 | English | English | 44 | English |
| Lightning | No | Yes | No | No | No |

Bark is not an Alby replacement. It is a focused tool for people who want self-sovereign Nostr signing with optional derived identity management.

## Privacy

See [PRIVACY.md](PRIVACY.md). TL;DR: Bark stores connection, instance, signer
health, and policy state locally. No analytics, no tracking, and your signing
keys never leave your signer.

## Part of ForgeSworn

> For internal architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md).

Bark is part of the [ForgeSworn](https://github.com/forgesworn) open-source ecosystem for sovereign identity and commerce on Nostr and Lightning. It is the browser end of the Heartwood family: [Cambium](https://github.com/forgesworn/cambium) fills the same role for Android apps (a NIP-55 signer that proxies to Heartwood), and [Sapwood](https://github.com/forgesworn/sapwood) provisions and manages the signer itself.

## Part of the ForgeSworn Toolkit

[ForgeSworn](https://forgesworn.dev) builds open-source cryptographic identity, payments, and coordination tools for Nostr.

| Library | What it does |
|---------|-------------|
| [nsec-tree](https://github.com/forgesworn/nsec-tree) | Deterministic sub-identity derivation |
| [ring-sig](https://github.com/forgesworn/ring-sig) | SAG/LSAG ring signatures on secp256k1 |
| [range-proof](https://github.com/forgesworn/range-proof) | Pedersen commitment range proofs |
| [canary-kit](https://github.com/forgesworn/canary-kit) | Coercion-resistant spoken verification |
| [spoken-token](https://github.com/forgesworn/spoken-token) | Human-speakable verification tokens |
| [toll-booth](https://github.com/forgesworn/toll-booth) | L402 payment middleware |
| [geohash-kit](https://github.com/forgesworn/geohash-kit) | Geohash toolkit with polygon coverage |
| [nostr-attestations](https://github.com/forgesworn/nostr-attestations) | NIP-VA verifiable attestations |
| [dominion](https://github.com/forgesworn/dominion) | Epoch-based encrypted access control |
| [nostr-veil](https://github.com/forgesworn/nostr-veil) | Privacy-preserving Web of Trust |

## Licence

MIT
