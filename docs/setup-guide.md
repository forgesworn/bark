# Heartwood + Bark Setup Guide

Set up a Heltec WiFi LoRa 32 V4 as a Nostr hardware signing device, with the Bark
Chrome extension for web app integration. Your private keys live on the ESP32 —
never in the browser, never on your computer.

**What you'll have when done:** Any Nostr web app (Snort, Habla, Coracle, etc.)
calls `window.nostr` → Bark forwards via relay → bridge pipes to ESP32 → device
signs → response flows back. Your nsec never leaves the chip.

---

## Prerequisites

- **Heltec WiFi LoRa 32 V4** (ESP32-S3) — connected via USB-C to your Mac
- **macOS** with Homebrew installed
- **Chrome** (or Chromium-based browser)
- **A 12-word BIP-39 mnemonic** — generate one fresh or use an existing one. This is your master seed — all Nostr identities derive from it. Back it up safely.

---

## Step 1: Install the Rust + ESP toolchain

The firmware builds with the Xtensa ESP32 Rust toolchain. The bridge and
provisioning tools build with standard Rust.

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install ESP-specific tools
cargo install espup ldproxy espflash

# Install the ESP Rust toolchain (Xtensa target)
espup install

# Source the ESP environment (add this to your shell profile)
source ~/export-esp.sh
```

Verify:
```bash
rustc --version          # Should show 1.70+
espflash --version       # Should show espflash
```

---

## Step 2: Install Node.js

Bark is a Chrome extension built with esbuild.

```bash
# If you don't have Node.js
brew install node

# Verify
node --version    # 18+ recommended
npm --version
```

---

## Step 3: Clone the repos

```bash
mkdir -p ~/nostr-signer && cd ~/nostr-signer

git clone https://github.com/forgesworn/heartwood-esp32.git
git clone https://github.com/forgesworn/bark.git
```

---

## Step 4: Build and flash the firmware

Connect the Heltec V4 to your Mac via USB-C. Find the serial port:

```bash
ls /dev/cu.usbserial-*
# or on newer Macs with ESP32-S3 USB-CDC:
ls /dev/cu.usbmodem*
```

Note the port name (e.g. `/dev/cu.usbserial-1140`). You'll use it in every step.

Build and flash:

```bash
cd ~/nostr-signer/heartwood-esp32/firmware

# Source ESP toolchain (if not in your profile)
source ~/export-esp.sh

# Build
cargo build

# Flash (replace with your actual port)
espflash flash target/xtensa-esp32s3-espidf/debug/heartwood-esp32 --port /dev/cu.usbserial-1140
```

After flashing, the OLED should display **"Awaiting secret..."** — the device is
ready for provisioning.

**Troubleshooting:**
- If `espflash` can't find the device, try holding the BOOT button while plugging
  in USB, then release after 2 seconds.
- If the build fails with alignment errors, ensure you're using the ESP toolchain
  (`source ~/export-esp.sh`), not the standard Rust toolchain.

---

## Step 5: Provision the device

This writes your master secret to the ESP32's secure NVS storage. You only do this
once per device (or when you want to add a new master identity).

```bash
cd ~/nostr-signer/heartwood-esp32/provision

# Build
cargo build

# Run provisioning (replace port)
cargo run -- --port /dev/cu.usbserial-1140 --mode tree-mnemonic --label "default"
```

The tool will prompt you:
1. **Enter your 12-word mnemonic** — type or paste it, press Enter
2. **Enter passphrase** — press Enter for no passphrase (or enter one for extra security)
3. **Confirm the derived npub** — the tool shows your master public key

On success:
```
ACK received. Master 'default' provisioned.
```

The OLED now shows your npub. The device is ready.

**Important:** Write down and securely store your mnemonic. It's the only way to
recover your identities. The device stores the derived secret, not the mnemonic.

---

## Step 6: Generate a bunker secret

The bridge needs a bunker secret (private key) for relay authentication and NIP-44
encryption. This is NOT your master key — it's a separate key for the transport layer.

```bash
# Generate a random 32-byte hex secret
openssl rand -hex 32
```

Save this output somewhere safe (e.g. a file). You'll pass it to the bridge with
`--bunker-secret`. Example output:
```
a1b2c3d4e5f6...  (64 hex characters)
```

**Note:** The bunker secret can also be an nsec (bech32-encoded). A fresh random
hex string is simplest.

---

## Step 7: Start the bridge

The bridge connects to Nostr relays and forwards NIP-46 signing requests to the
ESP32 over USB serial.

```bash
cd ~/nostr-signer/heartwood-esp32/bridge

# Build
cargo build

# Run (replace port and bunker-secret)
cargo run -- \
  --port /dev/cu.usbserial-1140 \
  --bunker-secret YOUR_64_CHAR_HEX_SECRET \
  --relays wss://relay.damus.io,wss://nos.lol
```

On success you'll see:
```
Bunker pubkey: npub1...
Mode: bridge-decrypts (plaintext)
Listening for NIP-46 requests...
```

**The bridge prints a bunker URI** — it looks like:
```
bunker://abc123...?relay=wss://relay.damus.io&relay=wss://nos.lol
```

**Copy this URI.** You'll paste it into Bark in the next step.

Leave the bridge running in this terminal.

---

## Step 8: Build and install Bark

Open a new terminal:

```bash
cd ~/nostr-signer/bark

# Install dependencies and build
npm install
npm run build
```

Install in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `dist/` directory inside `~/nostr-signer/bark/`
5. Bark appears in your extensions toolbar (puzzle piece icon → pin it)

---

## Step 9: Connect Bark to Heartwood

1. Click the **Bark** icon in your Chrome toolbar
2. You'll see the setup screen: "Add Heartwood"
3. Paste the **bunker URI** from Step 7 into the input field
4. Click **Connect**

Bark connects to the relay, finds your Heartwood device, and shows:
- Green dot (connected)
- Your active persona name and npub
- Relay connection status

---

## Step 10: Test it

1. Go to [snort.social](https://snort.social) (or any Nostr web app)
2. Click "Login" → "Use Extension (NIP-07)"
3. Snort calls `window.nostr.getPublicKey()` → Bark returns your pubkey
4. Write a note and post it
5. Bark auto-signs the kind 1 event (no popup — it's in the "allow" policy)
6. If you try to update your profile (kind 0), Bark shows an approval popup

**What you should see in the bridge terminal:**
```
NIP-46 request from <client-pubkey>
Decrypted request: {"method":"sign_event",...}
ESP32 response: {"result":"..."}
Response published: <event-id>
```

---

## Signing policies

Bark has configurable signing policies. Click the Bark popup → expand
**"Signing Policies"** to see and edit rules.

**Defaults:**
- Everything auto-signs except kind 0 (profile), kind 3 (contacts), and
  kind 10002 (relay list) — those show an approval popup
- You can add custom kind protections (e.g. kind 30023 for long-form articles)
- You can add per-site rules: trust specific sites, block others

---

## Persona management (Heartwood-specific)

Heartwood derives unlimited personas from your master mnemonic. In the Bark popup:

- **Personas list** shows all derived identities
- **Derive** — enter a purpose name (e.g. "social", "work", "anon") to create a
  new persona. Each persona has a unique npub derived from your master seed.
- **Switch** — click a persona to switch your active signing identity
- All personas are recoverable from the same mnemonic

---

## Troubleshooting

**Bark says "Connecting..." but never connects:**
- Is the bridge running? Check the terminal.
- Is the bunker URI correct? It should start with `bunker://`.
- Are the relays reachable? Try `wss://relay.damus.io` and `wss://nos.lol`.

**Bridge says "ESP32 forward failed":**
- Is the device plugged in? Check `ls /dev/cu.usbserial-*`.
- Has the device been provisioned? The OLED should show an npub, not "Awaiting secret".

**Signing hangs (no response):**
- MV3 service workers kill WebSocket connections when idle. Click the Bark popup
  to wake it, then retry.
- If Bark shows a red dot, click Retry to reconnect.

**"Request denied by policy":**
- A site or method is set to "deny" in your policies. Check Bark popup → Signing Policies.

**Profile update popup doesn't appear:**
- Make sure kind 0 is in your protected kinds list (it is by default).
- If you trusted the site with "allow all", the site default overrides global kind rules.

---

## Architecture summary

```
Web app (snort.social)
  ↓ window.nostr.signEvent()
Bark (Chrome extension, no keys)
  ↓ NIP-46 request via Nostr relay
Bridge (Mac/Pi, no keys in device-decrypts mode)
  ↓ Serial USB
ESP32 (holds master secret, signs events)
  ↓ Serial USB
Bridge → relay → Bark → web app
```

Your private key only exists on the ESP32 chip. The bridge is a dumb pipe.
Bark is a dumb relay. Neither ever sees your nsec.
