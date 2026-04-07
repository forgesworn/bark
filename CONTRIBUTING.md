# Contributing to Bark

Bark is a minimal NIP-07 browser extension. Contributions are welcome — keep
things focused, small, and in keeping with the no-local-keys philosophy.

## Build and test

```bash
npm install
npm run build        # esbuild → dist/
npm run watch        # incremental rebuild on file change
npm test             # vitest unit tests (run before any PR)
npm run test:watch   # vitest in watch mode
npm run package      # build + zip for release
```

Load `dist/` as an unpacked extension in Chrome (`chrome://extensions/`,
Developer mode → Load unpacked).

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
2. Run `npm test` — all tests must pass.
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
