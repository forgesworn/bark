# Bark + Heartwood: Device-Decrypts Default + Policy UI Polish

## Context

As of 2026-04-04, the Bark approval policy engine is shipped and working:
- `evaluatePolicy()` with per-site, per-kind rules (allow/ask/deny)
- Background service worker uses `checkApproval()` for all requests
- Approval popup handles all method types (signEvent any kind, getPublicKey, nip44)
- Settings UI in popup: add/remove kind rules, add/remove site rules, reset to defaults
- 92 tests passing across policy and background test suites
- Bridge modes renamed: "legacy" → "bridge-decrypts", "passthrough" → "device-decrypts"

The ESP32 firmware has full device-decrypts support (ENCRYPTED_REQUEST/RESPONSE,
SESSION_AUTH, on-device NIP-44). The bridge supports `--bridge-secret`. Both modes
work end-to-end.

## What to build

### 1. Device-decrypts as the default provisioning flow

Make new Heartwood setups use device-decrypts mode automatically, without requiring
the user to manually pass `--bridge-secret`.

**Bridge auto-discovery (heartwood-esp32/bridge/src/main.rs):**

When `--bridge-secret` is not provided but `--data-dir` is, look for
`{data-dir}/bridge-secret.hex`. If found, read it and use device-decrypts mode.
Log which mode was selected and why:

```
Mode: device-decrypts (encrypted) — secret from /var/lib/heartwood/hsm/bridge-secret.hex
Mode: bridge-decrypts (plaintext) — no --bridge-secret and no secret file in data dir
```

If `--bridge-secret` is explicitly passed, it takes precedence over the file.

**Provisioning CLI (heartwood-esp32/provision/src/main.rs):**

During provisioning (all three modes: bunker, tree-mnemonic, tree-nsec):
1. Generate a random 32-byte bridge secret
2. Send it to ESP32 via SET_BRIDGE_SECRET frame
3. Save it as `bridge-secret.hex` (64 hex chars + newline) in the output directory
4. Print: "Bridge secret saved to {path} — the bridge will use device-decrypts mode automatically"

If reprovisioning and a bridge-secret.hex already exists, ask whether to regenerate
or keep the existing one (regenerating means the bridge needs restarting).

**Testing:**
- Unit test: bridge reads secret from file, falls back to bridge-decrypts if missing
- Integration test: provision → bridge auto-discovers → SESSION_AUTH succeeds
- Test explicit `--bridge-secret` overrides file

### 2. Policy UI improvements in Bark

The settings UI works but is minimal. These improvements make it genuinely useful:

**Per-site kind overrides:**

When clicking a site rule in the popup, expand it to show per-kind overrides for
that site. The data model already supports this (`siteRules[origin].kindRules`),
the UI just doesn't expose it.

Mock-up:
```
snort.social                    [ALLOW]
  ├ Kind 0 (Profile metadata)  [ASK]
  ├ Kind 3 (Contact list)      [ASK]
  └ + Add kind override
```

**Action cycling:**

Click a policy action badge to cycle: allow → ask → deny → (remove). Saves
immediately on each click. More intuitive than remove + re-add.

**"Remember this site" from approval popup:**

When the user approves or denies a request in the approval popup, offer a checkbox:
"Remember for {origin}". If checked, create a site rule automatically. For "allow",
set `signEvent: 'allow'` with a kindRule for the specific kind set to 'allow'. For
"deny", set the method to 'deny'.

This is how Amber builds trust progressively — the user doesn't need to go to
settings manually.

**Method-level site controls:**

Expand site rules to show separate toggles for signEvent, getPublicKey,
nip44.encrypt, nip44.decrypt. Currently the UI sets all methods to the same action.

### 3. Heartwood-device web UI mode indicator

The heartwood-device web UI (running on the Pi) should show which bridge mode is
active. This is a read-only indicator, not a control — the mode is determined by
the bridge secret, not a toggle.

Show in the device status panel:
- "Bridge mode: device-decrypts (encrypted)" with a green lock icon
- "Bridge mode: bridge-decrypts (plaintext)" with an amber warning icon
- "Bridge: not connected" if the bridge isn't running

## Repos involved

- `heartwood-esp32/bridge/` — auto-discovery of bridge secret from data dir
- `heartwood-esp32/provision/` — generate and save bridge secret during provisioning
- `heartwood-esp32/firmware/` — no changes needed (already supports both modes)
- `bark/src/popup.js` + `bark/src/popup.html` — policy UI improvements
- `bark/src/approve.js` + `bark/src/approve.html` — "remember this site" feature
- `heartwood-device/` — web UI mode indicator (if this repo exists)

## Key files

- `heartwood-esp32/bridge/src/main.rs` — CLI args, mode selection (~line 121-157, 447-463)
- `heartwood-esp32/provision/src/main.rs` — provisioning flow
- `bark/src/policy.js` — policy evaluation (no changes needed, just reference)
- `bark/src/popup.js` — policy UI rendering and event handlers
- `bark/src/popup.html` — policy UI markup
- `bark/src/approve.js` — approval popup logic
- `bark/src/background.js` — checkApproval, openApprovalWindow

## Priority order

1. Bridge auto-discovery (small, unblocks everything else)
2. Provisioning CLI generates bridge secret (completes the default flow)
3. "Remember this site" in approval popup (highest UX impact)
4. Per-site kind overrides in popup (power user feature)
5. Action cycling (polish)
6. Method-level site controls (nice to have)
7. Web UI mode indicator (when heartwood-device exists)

## Design insight from this session

When a site has a method default (`signEvent: 'allow'`), it takes precedence over
global kindRules. So trusting Snort means trusting it for ALL kinds unless you add
explicit site-level kindRules. This matches Amber's model — per-app trust is broad.

If a user wants Snort trusted for notes but still asked for profile changes:
```json
"https://snort.social": {
  "signEvent": "allow",
  "kindRules": { "0": "ask", "3": "ask", "10002": "ask" }
}
```

The "remember this site" feature should generate this pattern automatically when
a user approves a request but wants to keep kind-level protection.

## Grant status

G23 (OpenSats Heartwood, $19K) — draft ready, submitting week of 7 April.
Per-site permissions and auto-reconnect classified as foundation (already shipped).
M5 is now Firefox port + store submissions. Device-decrypts default flow is
foundation/hardening work (M4 adjacent but not a milestone deliverable).

## British English. No Co-Authored-By. ESM-only. Vitest for tests.
