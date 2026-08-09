# Automated store submission

Two routes over the same scripts; both are manual triggers, because a store
submission is a deliberate act. Review queues at both stores still apply —
this removes the dashboard clicking, not the review wait.

**Primary — Actions**: Actions → **Store submit** → Run workflow → enter the
release tag. The repo is public, so hosted minutes are free. Needs the six
values below as repo secrets (`gh secret set NAME --repo forgesworn/bark`).

**Fallback — local**, from any machine with `git`, `gh` and Node:

```bash
npm run store:submit -- v1.3.7                # both stores
npm run store:submit -- v1.3.7 --no-firefox   # CWS only
npm run store:submit -- v1.3.7 --no-chrome    # AMO only
npm run store:submit -- v1.3.7 --no-publish   # CWS: upload without submitting
```

Either route downloads the release's own CI-built zips, cuts the AMO source
zip and the release-notes changelog **from the tag** (so a moved-on working
tree cannot leak into the submission), then submits: package to the Chrome
Web Store, package + source + changelog-derived release notes to AMO. The AMO
step fails loudly if the version has no changelog section.

Neither store API can **create** a listing — only update one — so the very
first submission of a new extension is always a dashboard job. Bark's listings
already exist on both stores.

## Credentials

Six values, minted once (below). For Actions, store each as a repo secret;
for the local route, the scripts read the environment first, then
`~/ops/bark-store.env` (override the path with `BARK_STORE_ENV`). Keep that
file outside the repo, `chmod 600`, plain `KEY=VALUE` lines:

```
CWS_EXTENSION_ID=...
CWS_CLIENT_ID=...
CWS_CLIENT_SECRET=...
CWS_REFRESH_TOKEN=...
AMO_JWT_ISSUER=user:12345:67
AMO_JWT_SECRET=...
```

### One-time: Chrome Web Store (a human job, ~15 minutes)

The CWS API acts as the developer account behind an OAuth refresh token;
service accounts are not supported.

1. In [console.cloud.google.com](https://console.cloud.google.com), signed in
   as the developer account: create a project (any name), then **Enabled APIs
   & services → Enable → "Chrome Web Store API"**.
2. **OAuth consent screen**: External, fill the two required fields, and —
   this matters — set **Publishing status to "In production"**. In "Testing"
   status Google expires every refresh token after seven days.
3. **Credentials → Create credentials → OAuth client ID → Desktop app.** Note
   the client ID and secret.
4. Mint the refresh token on any machine with a browser logged into the
   developer account:

   ```bash
   node scripts/cws-mint-token.mjs <client_id> <client_secret>
   ```

5. The extension ID is in the dashboard item URL
   (`chrome.google.com/webstore/devconsole/…/<ID>/…`).

### One-time: AMO (~2 minutes)

[addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/)
→ generate new credentials; the issuer looks like `user:12345:67`.

The add-on is addressed by its gecko ID (`bark@forgesworn.local`, set in
`esbuild.config.js`); override with `AMO_ADDON_ID` if that ever changes.

## Per release

1. Tag pushed, release workflow green, release published (the existing flow).
2. Actions → **Store submit** → run with the tag — or locally,
   `npm run store:submit -- vX.Y.Z`.
3. AMO release notes come from the version's changelog section automatically.
   CWS has no per-version notes; keep the long description in
   `docs/store-listing.md` current instead.

## Failure notes

- CWS `publish` returns the review state, not instant publication;
  ITEM_PENDING_REVIEW is success.
- AMO validation is polled for up to 2½ minutes; a validation failure prints
  the validator output and stops before any version is created.
- A CWS 401 usually means the refresh token died — re-run the mint script
  and update the env file; check the consent screen is still "In production".
