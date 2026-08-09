# Automated store submission

The `Store submit` workflow (Actions → Store submit → Run workflow) uploads a
released version to both stores: package to the Chrome Web Store, package +
source zip + changelog-derived release notes to AMO. It is manual-trigger on
purpose — a submission is a deliberate act — and inert until the six secrets
below exist. Review queues at both stores still apply; this removes the
dashboard clicking, not the review wait.

Both scripts also run locally with the same environment variables, e.g.
`CWS_… node scripts/cws-submit.mjs --zip bark-v1.3.7.zip`.

Neither store API can **create** a listing — only update one — so the very
first submission of a new extension is always a dashboard job. Bark's listings
already exist on both stores.

## One-time: Chrome Web Store credentials (a human job, ~15 minutes)

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
6. Store all four:

   ```bash
   gh secret set CWS_EXTENSION_ID  --repo forgesworn/bark
   gh secret set CWS_CLIENT_ID     --repo forgesworn/bark
   gh secret set CWS_CLIENT_SECRET --repo forgesworn/bark
   gh secret set CWS_REFRESH_TOKEN --repo forgesworn/bark
   ```

## One-time: AMO credentials (~2 minutes)

1. [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/)
   → generate new credentials. The issuer looks like `user:12345:67`.
2. Store both:

   ```bash
   gh secret set AMO_JWT_ISSUER --repo forgesworn/bark
   gh secret set AMO_JWT_SECRET --repo forgesworn/bark
   ```

The add-on is addressed by its gecko ID (`bark@forgesworn.local`, set in
`esbuild.config.js`); override with `AMO_ADDON_ID` if that ever changes.

## Per release

1. Tag pushed, release workflow green, release published (the existing flow).
2. Actions → **Store submit** → Run workflow → enter the tag (e.g. `v1.3.7`).
3. AMO release notes come from the version's `CHANGELOG.md` section
   automatically — the submission fails loudly if the section is missing.
   CWS has no per-version notes; keep the long description in
   `docs/store-listing.md` current instead.

## Failure notes

- CWS `publish` returns the review state, not instant publication; ITEM_
  PENDING_REVIEW is success.
- AMO validation is polled for up to 2½ minutes; a validation failure prints
  the validator output and stops before any version is created.
- A CWS 401 usually means the refresh token died — re-run the mint script
  (step 4) and update the secret; check the consent screen is still
  "In production".
