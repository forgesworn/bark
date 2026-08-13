# Releasing Bark

From a clean `main` to both stores. Credentials and one-time setup live in
[store-submit.md](store-submit.md); this is the per-release runbook.

Two stages, deliberately decoupled:

| Stage | Trigger | What it does |
|---|---|---|
| Build | pushing a `v*` tag | tests, audits, packages all three targets, opens a **draft** GitHub release |
| Submit | manual dispatch | downloads the release assets, submits to AMO and/or CWS |

Everything submitted is cut **from the tag**, never the working tree, so a
moved-on checkout cannot leak into a submission. The submit workflow itself runs
from `main`, because the submit scripts do not exist in older tags' trees.

## 1. Prepare the version

Bump both files — the manifest is what browsers and stores read, `package.json`
is what the zip naming and tooling read, and they must match:

```bash
# package.json and src/manifest.json
"version": "1.3.9"
```

Then move the changelog's `[Unreleased]` content under a real heading:

```markdown
## [Unreleased]

## [1.3.9] - 2026-08-13
```

**This is not cosmetic.** `release.yml` extracts the release notes by matching
`## [<version>]` in `CHANGELOG.md` and **fails the build** if that section is
missing or empty. The same section becomes AMO's release notes.

Verify before tagging:

```bash
npm run verify          # tests, all three builds, audit
npm run e2e:chromium    # optional but cheap; see e2e-hardening.md
```

## 2. Commit and tag

```bash
git commit -am "chore: release 1.3.9"
git push
git tag v1.3.9
git push origin v1.3.9
```

The tag push fires `release.yml`. Wait for it to go green:

```bash
gh run list --workflow=release.yml --limit 1
```

Tags are immutable content in this pipeline — a released tag can never be
retrofitted. If you tagged before a fix landed, cut the next patch version
rather than moving the tag.

## 3. Publish the draft release

The build lands as a **draft**, and nothing downstream consumes a draft:

```bash
gh release edit v1.3.9 --draft=false
```

Skipping this is the classic failure — the submit run dies immediately with
`release not found`, which looks like a tag or credentials problem and is
neither.

Worth a glance before publishing: confirm the built artefact really contains
what you think it does.

```bash
gh release download v1.3.9 -p "bark-firefox-v1.3.9.zip"
unzip -p bark-firefox-v1.3.9.zip manifest.json | head -20
```

## 4. Submit to Mozilla (AMO) — automated

Actions → **Store submit** → Run workflow → enter the tag, Firefox on, Chrome
off. Or locally, with credentials in place:

```bash
npm run store:submit -- v1.3.9 --no-chrome
```

A good run reads:

```
== cut the source zip from the tag
== submit to AMO
validated bark-firefox-v1.3.9.zip
version 1.3.9 submitted for review
source attached: bark-v1.3.9-source.zip
```

The source zip is required because esbuild bundles and minifies — AMO needs
reviewable source whenever the shipped code is not the code you wrote, and a
submission without it stalls in review.

Check when it goes live:

```bash
curl -sL https://addons.mozilla.org/api/v5/addons/addon/bark-nostr/ \
  | python3 -c "import json,sys;d=json.load(sys.stdin);c=d['current_version'];print(c['version'], c['compatibility'])"
```

`compatibility` should list both `firefox` and `android`. If `android` is
missing, the build lacked `browser_specific_settings.gecko_android` and the
listing is desktop-only regardless of what the code does — see
[mobile.md](mobile.md).

## 5. Submit to Chrome (CWS) — dashboard job

Chrome is manual **by choice**: the CWS API's only auth path is a Google Cloud
OAuth app consented by the developer account, which we deliberately do not
maintain. The scripts support it if you ever mint those credentials
(`--no-chrome` is what turns it off), but the standing process is:

1. [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   → the Bark item → **Package** → **Upload new package**.
2. Upload `bark-vX.Y.Z.zip` from the GitHub release — the plain one, not the
   `-firefox` or `-safari` zip.
3. Paste anything the listing needs from [store-listing.md](store-listing.md).
   CWS has no per-version release notes, so keep the long description current
   there instead.
4. **Submit for review.**

If you do wire up CWS credentials later, `ITEM_PENDING_REVIEW` is a success
response, not an error — it means queued, not rejected.

## 6. Safari

`bark-safari-vX.Y.Z.zip` is built every release but is not submitted anywhere.
It exists for Apple's Safari Web Extension conversion flow, which is a local
Xcode job on a Mac. No store listing today.

## Checklist

- [ ] `package.json` and `src/manifest.json` both bumped, and matching
- [ ] `CHANGELOG.md` has a populated `## [X.Y.Z]` section
- [ ] `npm run verify` green
- [ ] Commit pushed to `main`, tag pushed
- [ ] `release.yml` green
- [ ] Draft release **published**
- [ ] Store submit run green; AMO reports "submitted for review"
- [ ] CWS package uploaded and submitted from the dashboard
- [ ] AMO listing shows the new version once review clears
