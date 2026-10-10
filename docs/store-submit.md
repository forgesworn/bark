# Automated store submission

Chrome uses the [Chrome Web Store v2 API](https://developer.chrome.com/docs/webstore/api)
with a [service account](https://developer.chrome.com/docs/webstore/service-accounts).
GitHub obtains a short-lived token through Workload Identity Federation; no
Google private key, client secret or refresh token is stored in the repository.
Firefox uses the existing AMO credentials. Store review remains separate from
successful upload and submission.

## Run a submission

Actions → **Store submit** → Run workflow on **main** → enter a published
release tag and select the stores. For the first Chrome run of `v1.3.14`, turn
Chrome **on** and Firefox **off**: Firefox has already been submitted.

```bash
gh workflow run store-submit.yml --ref main \
  -f version=v1.3.14 -f chrome=true -f firefox=false
```

For setup diagnostics before linking the publisher, add
`-f chrome_auth_only=true`. This obtains a Google token without accessing the
store or submitting to either browser store. It does not prove store permissions.

After a successful live Chrome submission, set repository variable
`CWS_AUTO_SUBMIT=true`. Publishing a stable GitHub release then automatically
submits its Chrome package. Drafts and prereleases do not trigger submission.
Release publication must be done by a user or an appropriately authorised app:
[GitHub events produced using a workflow's `GITHUB_TOKEN`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
generally do not start another workflow. Manual dispatch remains available for retries and old tags.
Firefox remains an explicit selection to avoid duplicate AMO submissions.

All store runs are serialised. The submit code comes from `main`; packages come
from the release assets. Their SHA-256 digests must match GitHub's metadata, the
tag must be in `origin/main` history, and Chrome's ZIP manifest must match the
requested version. AMO source and changelog are read from that tag. Local runs
need a recent `git fetch origin --tags`, `gh`, Node 22–24 and `unzip`.

Chrome checks existing store status first. An already submitted or published
matching version is a no-op. A different pending revision blocks the upload.
Asynchronous uploads are polled before publishing; failed, unknown or timed-out
validation never submits for review. HTTP requests have a 60-second timeout and
mutations are not automatically replayed. Publishing requests normal review,
blocks on validation warnings, and asks Google to release after approval.

## One-time Chrome setup

Provisioned for Bark on 2026-10-08:

| Setting | Value |
|---|---|
| Google Cloud project | `forgesworn-bark-release` |
| Project number | `379219302085` |
| Service account | `bark-store@forgesworn-bark-release.iam.gserviceaccount.com` |
| Workload identity pool / provider | `bark-github` / `bark-store` |
| Chrome extension | `gdpcaoemjjglcebpjjljmhndbpeckpln` |

The Chrome Web Store, IAM, IAM Credentials and Security Token Service APIs are
enabled. No billing account is attached. The service account has no project-wide
roles and no user-managed key. Its impersonation binding grants only
`roles/iam.workloadIdentityUser` to repository ID `1198475421` through this pool.

The provider condition checks repository ID `1198475421`, owner ID `269157051`,
and the exact `forgesworn/bark/.github/workflows/store-submit.yml` workflow path.
Only manual dispatch on `refs/heads/main` or `release` events on `refs/tags/v*`
are accepted. Pull requests and other workflows cannot use this provider.

Publisher setup (completed for Bark on 2026-10-08):

1. In **Chrome Web Store Developer Dashboard**, use the **Publisher** selector
   at the top right to choose the publisher whose **Items** list contains Bark.
   Then open **Settings → Management → Service account**, link the email above
   and save. **Account** is a sidebar section heading, not a navigation button.
   This grants access to the publisher's items, not only Bark.
   Google currently permits one linked service account per publisher; inspect
   an existing link before replacing it.
2. Copy the **Publisher ID** from **Settings → Profile** (not the extension ID)
   into repository variable `CWS_PUBLISHER_ID`. Bark's publisher ID is
   `6821c2aa-841f-427c-b3de-9d4ff7b1a4e0`.
3. The already configured repository variables are `CWS_SERVICE_ACCOUNT` and
   `CWS_WORKLOAD_IDENTITY_PROVIDER` (full provider resource name). They are
   identifiers, not secrets.
4. Run Chrome-only submission, confirm `PENDING_REVIEW` or an accepted store
   state, then enable `CWS_AUTO_SUBMIT`. A green mocked test does not prove the
   publisher link or Google's live acceptance.

Live evidence: [workflow 37706070508](https://github.com/forgesworn/bark/actions/runs/37706070508)
authenticated through GitHub OIDC, verified the released `v1.3.14` Chrome ZIP,
uploaded it and received `PENDING_REVIEW` on 2026-10-08 at 00:07:58 UTC.
Firefox was disabled for this run. `CWS_AUTO_SUBMIT=true` was then enabled and
read back from the repository configuration. Future stable release publication
is configured to trigger Chrome submission; this first live acceptance used
manual workflow dispatch. Google review approval, public availability and
installation in the user's browser were not established by this run.

The v2 service-account route replaces the former OAuth refresh-token helper.
Do not create or upload a service-account JSON key.

## Local fallback

Use an authorised service-account impersonator to put a short-lived token in
`CWS_ACCESS_TOKEN` without printing it, along with `CWS_PUBLISHER_ID` and
`CWS_EXTENSION_ID`. Then:

```bash
npm run store:submit -- v1.3.14 --no-firefox
# Upload and validate only (does not submit Chrome for review):
npm run store:submit -- v1.3.14 --no-firefox --no-publish
```

The scripts read environment variables first, then `~/ops/bark-store.env`
(override with `BARK_STORE_ENV`). Keep any credentials file outside the repo,
mode `0600`, plain `KEY=VALUE` lines. Do not persist short-lived access tokens.

## Firefox credentials

[AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/) are
stored as repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. The add-on is
addressed by `bark@forgesworn.local`; `AMO_ADDON_ID` can override this locally.
Source and changelog-derived release notes are submitted with the package.

## Failure notes

- Missing `CWS_PUBLISHER_ID`: finish the dashboard link and repository variable.
- Google token exchange denied: check the provider condition, repository/workflow
  ref, and service-account binding. New IAM settings can take minutes to propagate.
- CWS 401/403: check token scope, enabled API and the publisher's linked account.
- Upload validation failure or publish warning: inspect the developer dashboard.
  The script deliberately does not dump provider response bodies into CI logs.
- A timeout after an upload or publish may mean Google accepted it but the reply
  was lost. Inspect status before retrying. A pending matching version is safe
  to rerun; an uploaded draft may need completion through the dashboard.
- `PENDING_REVIEW` is submission, not approval, public availability or a browser
  update. Verify the listing and installed extension separately.
- Missing release digest: reattach a verified CI asset through the release
  process; do not bypass the digest check.

See [releasing.md](releasing.md) for the full release process and Google's
[GitHub authentication action](https://github.com/google-github-actions/auth)
for the federation setup and supported token configuration.

## Firefox listing artwork

After a stable release is published, explicitly refresh its icon and five
preview screenshots from the tagged `docs/store-assets/` files:

```bash
gh workflow run store-artwork.yml --ref main -f version=v1.3.16
```

This uses the existing GitHub AMO credentials, preserves the old previews
until all replacements are uploaded and visible, and verifies the final list.
It is separate from package submission and runs only when requested.
Local validation without writes: `node scripts/amo-artwork.mjs v1.3.16`.
Chrome promotional images still require the developer dashboard.
