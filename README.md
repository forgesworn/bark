# Bark

The protective outer layer of [Heartwood](https://github.com/forgesworn/heartwood).

Bark is a minimal NIP-07 browser extension that signs Nostr events through a remote signer via NIP-46. No keys in the browser. No accounts. No bloat.

## What it does

- **Signs Nostr events** via NIP-46 remote signing (NIP-07 interface for web apps)
- **Works with any NIP-46 bunker** — nsecBunker, Amber, or your own signer
- **Switches personas** — derive unlimited identities from one mnemonic with [Heartwood](https://github.com/forgesworn/heartwood), switch in one click
- **Self-sovereign** — keys live on your device, never touch the browser

## What it doesn't do

- No wallet, no Lightning, no zaps
- No local key storage
- No NIP-44 encrypt/decrypt yet (waiting on Heartwood)

## Install

1. Download `bark-v1.0.0.zip` from the [latest GitHub release](https://github.com/forgesworn/bark/releases/latest)
2. Extract the zip
3. Open `chrome://extensions/`, enable Developer mode
4. Click "Load unpacked", select the extracted directory
5. Click the Bark icon, paste your bunker URI

### Build from source

```bash
git clone https://github.com/forgesworn/bark.git
cd bark && npm install && npm run build
```

Then load the `dist/` directory as above.

## Works with any NIP-46 bunker

Bark works as a standard NIP-07 provider with any NIP-46 bunker. Paste a `bunker://` URI from nsecBunker, Amber, or any compliant signer. The signing flow (`getPublicKey`, `signEvent`, `nip44.encrypt`, `nip44.decrypt`) works identically regardless of the backend.

Persona features (derive, switch, list) require [Heartwood](https://github.com/forgesworn/heartwood). When connected to a standard bunker, persona controls are visible but greyed out with a link to Heartwood.

## Heartwood RPC extensions

When connected to a Heartwood signer, Bark uses custom NIP-46 RPC methods for persona management. These are sent via `BunkerSigner.sendRequest()` over standard NIP-46 relay communication.

### `heartwood_list_identities`

Returns all derived identities on the device.

- **Params:** none
- **Returns:** `Array<{ pubkey: string, name?: string, purpose?: string }>`

### `heartwood_derive`

Derive a new identity from the device's mnemonic.

- **Params:** `[purpose: string, index: string]`
  - `purpose` — alphanumeric label, 1-64 chars (e.g. `"nostr"`, `"twitter"`)
  - `index` — derivation index as string, `"0"` to `"1000"`
- **Returns:** `{ pubkey: string, purpose: string, index: number }`

### `heartwood_switch`

Switch the active signing identity.

- **Params:** `[pubkey: string]` — 64-char lowercase hex public key
- **Returns:** `{ ok: true }`

## Comparison with other NIP-07 signers

| | Bark | Alby | nos2x | Remote NIP-07 |
|---|---|---|---|---|
| Key storage | None (remote signer) | Browser or Alby Hub | Browser | None (Amber) |
| NIP-46 backend | Any bunker | No | No | Amber only |
| Derived identities | Unlimited (Heartwood) | None | None | None |
| Self-sovereign signing | Yes | Software only | Software only | Phone (Amber) |
| Size | 5 files, 1 dependency | Large extension + hub | Small extension | Small extension |
| Lightning | No | Yes | No | No |

Bark is not an Alby replacement. It is a focused tool for people who want self-sovereign Nostr signing with optional derived identity management.

## Privacy

See [PRIVACY.md](PRIVACY.md). TL;DR: Bark stores a bunker URI and client secret locally. No data collection, no third-party services, no tracking. Your keys never leave your signer.

## Part of ForgeSworn

Bark is part of the [ForgeSworn](https://github.com/forgesworn) open-source ecosystem for sovereign identity and commerce on Nostr and Lightning.

## Licence

MIT
