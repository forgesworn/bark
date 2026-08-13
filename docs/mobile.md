# Bark on Android and GrapheneOS

Short answer: **Bark cannot run in Vanadium itself, and that will not change.**
On Android the routes are Cambium for native apps, direct NIP-46 login for web
apps, and — when a web app only speaks NIP-07 — Bark in Firefox for Android or
in a Vanadium-derived fork that re-enables extensions.

## Why not Vanadium

Vanadium is GrapheneOS's hardened Chromium build, and Chromium on Android has
never shipped the extensions subsystem — it is compiled out of the Android
target upstream, so there is no extension host for Bark to load into. This is
not a manifest or permissions problem that Bark can work around.

GrapheneOS has also ruled it out as a matter of policy. From the project's own
forum ([Extensions on Vanadium?](https://discuss.grapheneos.org/d/13520-extensions-on-vanadium),
June 2024):

> Extension support is not planned. It's not standard on Android, and it can
> reduce security. The right approach to implementing features is within the
> browser itself, rather than with extensions.

The position was unchanged as of the December 2025 thread
([Vanadium Extensions](https://discuss.grapheneos.org/d/21388-vanadium-extensions)),
where the stated objections were extension risk and the fingerprinting surface
that per-user extension sets create — Vanadium deliberately keeps one uniform
browser fingerprint.

Google's experimental extension-capable "desktop Android" Chrome builds do not
change this. They target Android-powered PCs, not phones, and Vanadium would
have to rebase onto them.

The general-purpose Chromium-on-Android browsers that do support extensions
(Kiwi, discontinued January 2025; Lemur; Edge Canary) are not hardened builds and
are a poor trade against Vanadium on GrapheneOS. Vanadium *forks* that re-enable
extensions are a different proposition — see route 4.

## What to use instead

In order of preference.

### 1. Native Nostr apps → Cambium (NIP-55)

For Amethyst, Primal, Voyage, and other Amber-compatible clients, use
[Cambium](https://github.com/forgesworn/cambium). It registers as a NIP-55
signer and proxies each request to the same Heartwood over NIP-46. Same trust
model as Bark — no key material on the phone — with a native approval UI.

This is the right answer for most Android use and needs no browser at all.

### 2. Web apps that speak NIP-46 directly

Many Nostr web clients accept a `bunker://` URI at login and hold the NIP-46
session themselves. Where that works, no extension is involved and the app runs
fine in Vanadium. Paste the same bunker URI you would give Bark.

Prefer this over route 3: it is fewer moving parts and keeps GrapheneOS users on
Vanadium.

Note that a web app holding its own bunker session does not get Bark's policy
engine — per-site allow/ask/deny, protected kinds, and privacy mode are Bark
features, not NIP-46 ones. Heartwood's own slot policy and physical confirmation
still apply.

### 3. Bark on Firefox for Android

For web apps that only offer NIP-07 login, install Firefox for Android (or a
hardened fork such as IronFox) alongside Vanadium and run Bark there. Gecko ships
a real extension host on mobile, and AMO is a first-party distribution channel.

Bark's Firefox build declares `browser_specific_settings.gecko_android`, so the
AMO listing is installable on Android. The floor is Firefox for Android 142 —
two releases above the desktop floor of 140, because the manifest's
`data_collection_permissions` declaration only reached Android in 142.

Keep Vanadium as the system browser and WebView; use Firefox only for the
NIP-07-only sites that need it.

### 4. Bark in a Vanadium fork that re-enables extensions

[Titanium Browser](https://github.com/jqssun/android-titanium-browser) (formerly
Helium) is built on Vanadium's patch set and adds an extension host back on top
of Chromium, plus patched-in Manifest V2 support. It tracks Chromium closely
(151.x as of August 2026). [Palladium](https://github.com/WeiguangTWK/Palladium)
does the same but releases less often.

Bark's ordinary Chromium build (`dist/`) is the one to load, through
`chrome://extensions` → Developer mode → Load unpacked, or from the Chrome Web
Store with desktop mode enabled. MV2 is listed as an *added* patch on top of
Chromium 151, where MV3 is the native extension platform, so Bark's MV3 service
worker should be the supported path — **inferred from the build description, and
unlike route 3 this has not been tested on a device.** Test before relying on it.

Two caveats:

- This is not Vanadium. It is a third-party fork, sideloaded and signed by its
  own maintainer, and its README says plainly that GrapheneOS with Vanadium is
  the stronger choice because Vanadium also patches the system WebView and
  benefits from OS-level kernel and memory hardening.
- Extension backgrounds get killed under Android memory pressure
  ([open issue](https://github.com/jqssun/android-titanium-browser/issues/57)),
  which drops Bark's NIP-46 WebSocket. Bark's existing MV3 reconnect backoff
  covers this, so expect reconnect latency rather than breakage.

On balance, prefer route 3 on GrapheneOS: Mozilla-maintained engine, AMO-signed
extension, and the approval-surface work below is tested against it. Route 4 is
worth knowing about if you want one Vanadium-like browser rather than two.

## Testing on a device

Verified on hardware: Pixel 10 Pro XL, GrapheneOS (Android 17, build 2026080500),
Firefox for Android 153.0.4, Bark 1.3.8 loaded as a temporary add-on against the
deterministic NIP-46 relay/signer from the e2e suite (reached over
`adb reverse`). Results in the table below.

To repeat it, connect the phone over adb with USB debugging on, install Firefox
for Android, enable **Settings → Advanced → Remote debugging via USB**, and run:

```bash
npx --yes web-ext@latest run --target=firefox-android \
  --source-dir=dist-firefox --firefox-apk=org.mozilla.firefox
```

or `npm run dev:android` if `web-ext` is on your PATH. This installs Bark as a
temporary add-on, so it disappears when Firefox restarts and needs no AMO
submission. Add `--adb-device=<serial>` when more than one device is attached.

External intents cannot open `moz-extension://` URLs, so seeding storage
directly means talking the remote debugging protocol to the background context.
The event page suspends after roughly 30 seconds idle, so attach the watcher
first and wake the background with a real NIP-07 call, otherwise you get the
`chrome://devtools/.../webextension-fallback.html` context instead of
`_generated_background_page.html`.

### Verified behaviour

| Check | Result |
|---|---|
| `window.nostr` injected (MAIN-world content script) | Present on `http://localhost:*` |
| Popup and approval pages at device width | Correct; no 980px fallback viewport |
| Unpaired request | Sanitised error, no crash |
| Ask-policy request | Opens `approve.html` as a foreground **tab** |
| Approval renders method detail | "Share Identity?" / "Sign Kind 1?" |
| Allow Once | `getPublicKey` returned the signer's pubkey |
| Trust Site | Signature returned; later calls skip the prompt |
| Deny | Request rejected, tab closed by the background |
| Dismissing the approval tab | `Request denied by user.` via `tabs.onRemoved` |
| Queued approvals | Second approval opens automatically once the first settles |
| Signing after event-page suspension | Reconnects and signs |

The signer observed the full exchange: `connect`,
`heartwood_list_identities`, `get_public_key`, `sign_event`, and keep-alive
`ping`s.

## Android differences in the Firefox build

Firefox for Android implements no `windows` API at all — `windows.create`,
`windows.update`, and `windows.onRemoved` are unsupported, not merely limited.
Bark's approval flow therefore switches surface:

| | Desktop | Firefox for Android |
|---|---|---|
| Approval surface | Popup window (420×520) | Foreground tab |
| Selected by | `approvalSurfaceKind()` in `background.js` | same |
| "Review in Bark" foregrounds via | `windows.update` | `tabs.update({active: true})` |
| Dismissing the surface | `windows.onRemoved` → deny | `tabs.onRemoved` → deny |
| Closing after a decision | `window.close()` in `approve.js` | background `tabs.remove()` |

`approve.html` and `popup.html` carry `width=device-width` viewport meta tags
and `max-width: 100%` bodies so both lay out against the device width. Neither
changes desktop rendering, where the popup sizes to the body.

Everything else Bark needs mirrors desktop support on Android: MAIN-world
content scripts (128), MV3 event-page backgrounds, `action.default_popup` and
badge APIs, `scripting`, `tabs`, and `permissions.request` (Android 120).

Per-site enablement degrades rather than breaks. `supportsDynamicSites()` gates
on `chrome.scripting.registerContentScripts`, and the Firefox build injects on
broad matches anyway, so it does not depend on that path.

## Not viable: bridging Cambium into Vanadium

Considered and rejected. A web page can launch Cambium with an `intent://` URL,
but NIP-55 returns its result as an Android activity result, which a page cannot
receive. Routing the response back through a deep link would mean navigating the
page away mid-request, inventing a non-standard protocol, and getting every web
client to adopt it — at which point those clients could simply support NIP-46
directly, which is strictly better and already works (route 2).
