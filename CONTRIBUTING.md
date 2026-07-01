# Contributing to Bark

Bark is a minimal NIP-07 browser extension. Contributions are welcome — keep
things focused, small, and in keeping with the no-local-keys philosophy.

## Build and test

```bash
npm install
npm run build        # esbuild -> dist/ (Chromium target)
npm run build:all    # Chromium, Firefox, and Safari outputs
npm run watch        # incremental rebuild on file change
npm test             # vitest unit tests (run before any PR)
npm run test:watch   # vitest in watch mode
npm run e2e:chromium # Playwright extension smoke tests against dist/
npm run e2e:deterministic # deterministic local NIP-46 signer smoke
npm run e2e:live     # optional live relay/signer smoke; requires BARK_LIVE_BUNKER_URI
npm run audit:prod   # production dependency audit
npm run verify       # test + all browser builds + full npm audit
npm run verify:full  # verify + Chromium browser E2E
npm run package      # build + zip for Chromium-family release
npm run package:all  # build + zip all browser targets
```

Load `dist/` as an unpacked extension in Chrome (`chrome://extensions/`,
Developer mode → Load unpacked).

Firefox uses `dist-firefox/`; Safari uses `dist-safari/` through Apple's Safari
Web Extension conversion flow.

CI runs `npm ci`, `npm test`, `npm run build:all`, `npm audit`, and
`npm run package:all` on Node 22 and Node 24.

The Heartwood/bridge HTTP contract tests run as part of `npm test`. Chromium
extension smoke tests run with `npm run e2e:chromium`, including the
deterministic local NIP-46 relay signer. The broader browser E2E matrix is
tracked in [docs/e2e-hardening.md](docs/e2e-hardening.md).

## Code style

- **British English** — colour, initialise, behaviour, licence, sanitise.
- **ESM throughout** — `import`/`export`, no CommonJS.
- **No local key material** — the extension must never generate, store, or
  touch private keys. This is a hard constraint, not a preference.
- **Pure functions for testable logic** — keep side-effect-free helpers
  (validators, sanitisers, policy evaluation) in separate exports so they can
  be unit tested without a browser environment.
- **No new dependencies** without discussion. Bark has one runtime dependency
  (`nostr-tools`) and the goal is to keep it that way.

## Commit format

```
type: short description
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`.

Examples:
```
feat: add policy editor to popup
fix: retry sendMessage on service worker wakeup
test: cover evaluatePolicy site-specific kind rules
```

No co-author lines. No issue numbers in the message unless the issue is on
GitHub and directly relevant.

## Pull request process

1. Fork the repo and work on a branch named `type/short-description`.
2. Run `npm run verify` — all tests, build, and audit checks must pass.
3. Load the built extension and manually verify the change in a browser.
4. Open a PR against `main` with a clear description of what changed and why.
5. Keep PRs focused. One logical change per PR.

If you are adding a Heartwood RPC method, update `llms.txt`, `llms-full.txt`,
and `README.md` accordingly.

## Security issues

Do not open a public issue for security vulnerabilities. Contact the maintainer
directly via Nostr DM or email (see the ForgeSworn GitHub organisation profile).
Include steps to reproduce and the potential impact.

## Licence

By contributing, you agree your changes will be released under the MIT licence.
