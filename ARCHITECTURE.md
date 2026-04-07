# Bark Architecture

> **This component is part of the [ForgeSworn Identity Stack](https://github.com/forgesworn/heartwood/blob/main/docs/ECOSYSTEM.md).** See the ecosystem overview for how it connects to the other components.

Bark is a Chrome/Edge browser extension (Manifest V3) that provides the standard `window.nostr` API. It holds no private keys. Every operation is forwarded over NIP-46 to a remote signer -- typically a Heartwood device, but any NIP-46 bunker works.

## Architecture overview

Five components, two security boundaries.

```mermaid
graph LR
    WA["Web Page"] --> P["provider.js"]
    P --> CS["content-script.js"]
    CS --> BG["background.js"]
    BG --> R["Nostr Relays"]
    R --> HW["Remote Signer"]

    style P fill:#3b82f6,color:#fff
    style CS fill:#3b82f6,color:#fff
    style BG fill:#3b82f6,color:#fff
    style R fill:#8b5cf6,color:#fff
    style HW fill:#f59e0b,color:#000
```

## Message passing chain

The critical path from web page to hardware signer. Five hops, each with a distinct security boundary.

```mermaid
sequenceDiagram
    participant WA as Web Page
    box rgb(59, 130, 246) Bark Extension
        participant P as provider.js
        participant CS as content-script.js
        participant BG as background.js
    end
    box rgb(139, 92, 246) Network
        participant R as Nostr Relay
    end
    box rgb(249, 158, 11) Signing Device
        participant HW as Remote Signer
    end

    WA->>P: window.nostr.signEvent(event)
    P->>CS: postMessage (bark-request)
    CS->>BG: chrome.runtime.sendMessage

    Note over BG: evaluatePolicy(method, params, origin)
    alt Policy = "ask"
        BG->>BG: Open approval popup (420x520)
        Note over BG: User clicks Allow / Deny
    end

    BG->>R: NIP-46 sign_event (NIP-44 encrypted)
    R->>HW: Forward request
    HW-->>R: Signed response
    R-->>BG: Forward response

    BG-->>CS: chrome.runtime response
    CS-->>P: postMessage (bark-response)
    P-->>WA: Resolve Promise with signed event
```

**provider.js** is injected into every page at `document_start`. It creates the `window.nostr` object and posts messages with a unique numeric ID and 60-second timeout.

**content-script.js** bridges the page and extension contexts. Validates origin, method, and ID. Retries if the service worker is asleep (MV3 lifecycle). Detects extension updates and notifies the page.

**background.js** is the MV3 service worker. Maintains the NIP-46 connection via nostr-tools' `BunkerSigner`, evaluates policies, manages approval popups, and dispatches requests.

## Policy system

Bark evaluates policies in priority order. The first matching rule wins:

1. Site-specific kind rule (e.g. kind 0 at example.com)
2. Site-specific method default
3. Global kind rule
4. Global method default
5. Fallback: allow

Default policies protect sensitive operations:

| Method | Default | Reason |
|--------|---------|--------|
| `getPublicKey` | allow | Public information |
| `signEvent` | allow | Most events are routine |
| `signEvent` (kind 0) | ask | Profile metadata |
| `signEvent` (kind 3) | ask | Contact list |
| `signEvent` (kind 10002) | ask | Relay list |
| `nip44.encrypt` | allow | App-level encryption |
| `nip44.decrypt` | allow | App-level decryption |

## Multi-instance support

Bark supports multiple bunker connections. Each instance stores:

```
{
  id: "heartwood-a1b2c3d4",
  name: "heartwood",
  address: "heartwood.local:3000",  // HTTP pairing address
  bunkerUri: "bunker://...",
  clientSecret: "hex64",       // Auth credential, not a signing key
  npub: "npub1...",
  signingPubkey: "",           // Active signing identity (if different from master)
  isHeartwood: true
}
```

Users switch between instances in the popup. Only one is active at a time.

## Heartwood detection

After connecting, Bark probes for Heartwood extensions:

1. Send `heartwood_list_identities` RPC
2. **Success:** Heartwood mode -- enable persona switching, derivation UI
3. **"not approved" error:** Heartwood detected, needs client approval on device
4. **"unknown method" error:** Standard NIP-46 bunker -- disable Heartwood features

Graceful degradation: Bark works with any NIP-46 bunker. Heartwood features are additive.

## HTTP pairing

For local Heartwood devices, users can enter `heartwood.local:3000` instead of a bunker URI:

1. Bark POSTs to `{address}/api/pair` with client pubkey
2. Heartwood returns bunker URI + instance metadata
3. Bark stores the URI for future NIP-46 connections

## Auto-reconnect

MV3 service workers die after ~30 seconds of inactivity, killing WebSocket connections. Bark reconnects with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | 5 seconds |
| 2 | 10 seconds |
| 3 | 30 seconds |
| 4+ | 60 seconds |

## Security model

**Zero key storage.** Bark never sees or stores private keys. It holds only:
- Bunker URI (public connection string)
- Client secret (auth credential for NIP-46, not a signing key)
- Relay URLs
- Policy preferences

**Error sanitisation.** Only safe error messages pass to web pages. Internal relay URLs, crypto details, and stack traces are replaced with generic messages.

**Stale detection.** If the extension reloads during a request (Chrome update, manual reload), the content script detects the invalidated context and shows a banner prompting the user to refresh the page.

## Integration points

- **[Heartwood](https://github.com/forgesworn/heartwood):** Remote signer. Bark sends NIP-46 requests, receives signatures. Uses Heartwood RPC extensions for persona management.
- **[nsec-tree](https://github.com/forgesworn/nsec-tree):** Conceptual dependency. Bark's persona UI maps to nsec-tree's derivation model (personas, groups, indices). No direct code dependency.
- **[ForgeSworn Identity Stack](https://github.com/forgesworn/heartwood/blob/main/docs/ECOSYSTEM.md):** Bark is the browser-facing layer of the signing stack.
