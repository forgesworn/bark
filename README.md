# Bark

The protective outer layer of [Heartwood](https://github.com/forgesworn/heartwood).

Bark is a minimal NIP-07 browser extension that signs Nostr events through your Heartwood device via NIP-46. No keys in the browser. No accounts. No bloat.

## What it does

- **Signs Nostr events** via your Heartwood device (NIP-07 + NIP-46)
- **Switches personas** -- derive unlimited identities from one mnemonic, switch in one click
- **Hardware-backed** -- keys live on your Pi behind Tor, never touch the browser

## What it doesn't do

- No wallet, no Lightning, no zaps
- No local key storage
- No NIP-44 encrypt/decrypt yet (waiting on Heartwood)

## Install

1. Clone and build:

   ```bash
   git clone https://github.com/forgesworn/bark.git
   cd bark && npm install && npm run build
   ```

2. Open `chrome://extensions/`, enable Developer mode
3. Click "Load unpacked", select the `dist/` directory
4. Click the Bark icon, paste your Heartwood bunker URI

## Requires

[Heartwood](https://github.com/forgesworn/heartwood) running on a Raspberry Pi (or any ARM Linux board) with NIP-46 remote signing enabled.

## How it works

Bark implements the [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) interface (`window.nostr`). When a website calls `signEvent()`, Bark forwards the request to your Heartwood device over NIP-46. Heartwood signs with the active persona's derived key and returns the signed event. The key never leaves the device.

Persona management uses Heartwood's extension methods (`heartwood_derive`, `heartwood_switch`, `heartwood_list_identities`) sent as custom NIP-46 RPC calls.

## Comparison with Alby

| | Bark | Alby |
|---|---|---|
| Key storage | None (Heartwood) | Browser or Alby Hub |
| Derived identities | Unlimited, one-click switch | None |
| Hardware signing | Pi behind Tor | Software only |
| Size | 5 files, 1 dependency | Large extension + hub |
| Lightning | No | Yes |

Bark is not an Alby replacement. It's a focused tool for people who want hardware-backed Nostr signing with derived identity management.

## Part of ForgeSworn

Bark is part of the [ForgeSworn](https://forgesworn.dev) open-source ecosystem for sovereign identity and commerce on Nostr and Lightning.

## Licence

MIT
