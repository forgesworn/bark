# Accessibility review

The popup and approval surfaces have been reviewed against WCAG 2.2 AA.
Automated checks provide regression coverage; they are not a conformance
certification or a substitute for assistive technology testing.

## Implemented fixes

| Area | Behaviour | WCAG reference |
| --- | --- | --- |
| Keyboard controls | Signers, personas, policy actions and disclosures use native buttons. Focus follows policy edits and removal, signer/persona selection and QR generation. | 2.1.1, 2.4.3 |
| Focus | Visible outlines; short approval windows focus the visible request heading. Enter there and Escape deny. Confirmation starts on Cancel. | 2.4.7, 2.4.11 |
| Contrast and state | Readable text and form boundaries; active signer, policy action and relay connection state have text as well as colour. Connecting text does not pulse. | 1.4.1, 1.4.3, 1.4.11 |
| Forms and updates | Visible field labels, named generated controls and deletion buttons, persistent errors, status/error announcements. Repeated unchanged signing status does not rewrite the live region. | 3.3.1, 3.3.2, 4.1.2, 4.1.3 |
| Timing | Accessibility settings offer 1, 5 or 10 minutes before future requests. The queue budget scales too. Approvals warn in the last 30 seconds and disable grants at expiry. The background checks deadlines even if timers resume late. | 2.2.1 |
| Reflow and spacing | Forms and policies wrap at 320 CSS pixels with increased text spacing and doubled text. Scrollable pairing addresses and request content are keyboard focusable. | 1.4.4, 1.4.10, 1.4.12 |
| Language | The popup/approval document language follows the selected extension catalogue, including the English fallback. New accessibility text falls back to English pending translation. | 3.1.1 |

Review time changes apply to subsequent requests. They do not extend a request
already open. Closing or denying still cancels a request. Signer and relay
timeouts remain separate; more review time does not grant permission.

## Automated evidence

Run on Node 24 after installing dependencies:

```sh
npm run verify
npm run e2e:accessibility
npm run e2e:approval
```

The five accessibility browser tests use built assets and controlled API/storage
data in isolated Chromium. Axe checks cover setup, QR pairing, expanded policies,
confirmation and approval. Keyboard checks cover Tab reachability, Enter/Space,
focus restoration and safe denial. Text tests combine WCAG spacing overrides
with 200% computed font sizes at a 320-pixel viewport. That viewport exercises
reflow equivalent to a 1280-pixel window at 400% zoom; it does not exercise a
browser's native zoom implementation.

The approval browser test separately uses the loaded extension, real provider
and content scripts, a loopback NIP-46 relay and a deterministic signer. It
checks deny, allow once, trust, protected kinds, queued requests, configured
timing and expiry refusal, including queued requests whose timers resume late.
All keys in these tests are disposable fixtures.

## Manual acceptance still required

- VoiceOver on macOS and TalkBack with Firefox on Android: control names,
  selected identity, error/status announcements, countdown warning, request
  content scrolling, and reading order through approval and confirmation.
- Native browser zoom at 200% and 400%, text scaling, high contrast/forced
  colours, and focus visibility through setup, QR, policy editing and approval.
- Firefox desktop, Firefox Android and Safari extension surfaces, including
  the foreground approval tab on Android and a small desktop popup window.
- Long translated labels, right-to-left languages, and translation of the new
  accessibility strings. Review imported identity confirmation, reconnect,
  unknown-kind/profile previews and encryption/decryption requests with a
  screen reader and a real signer.

These checks remain open. Successful builds and automated Chromium checks do
not establish physical device, real screen-reader or store-release acceptance.
