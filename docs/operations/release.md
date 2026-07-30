# shuv2code release runbook

The first prepared version is `0.1.0-alpha.1`. shuv2code is a fixed-version
product: `apps/server/package.json` is the source of truth, and named releases
must keep server, web, desktop, and mobile (`apps/mobile/app.config.ts`) aligned
via `scripts/update-release-package-versions.ts`.

## Version and npm channels

| Release class | Version example                               | npm dist-tag | GitHub status         |
| ------------- | --------------------------------------------- | ------------ | --------------------- |
| Nightly       | `0.1.0-nightly.20260730.1`                    | `nightly`    | prerelease            |
| Alpha/beta/RC | `0.1.0-alpha.2`, `0.1.0-beta.1`, `0.1.0-rc.1` | `next`       | prerelease            |
| Stable        | `0.1.0`                                       | `latest`     | full release / latest |

Rules enforced by `scripts/lib/release-version.ts`:

- `latest` is only valid for versions with no prerelease component.
- `next` is required for `alpha`, `beta`, `rc`, and other non-nightly prereleases.
- `nightly` is required for `-nightly.YYYYMMDD.N` versions.
- Nightlies do not rewrite committed versions. A committed prerelease keeps the
  same core (`0.1.0-alpha.2` → `0.1.0-nightly...`); a committed stable advances
  one patch (`0.1.0` → `0.1.1-nightly...`). Because SemVer sorts `nightly`
  before `rc` on the same core, the desktop nightly channel deliberately permits
  downgrade-style transitions; the `next` and `nightly` channels remain isolated.

Publishing is manual and must follow this order:

1. Prepare a reviewed version PR. For `latest` and `next`, the committed
   `apps/server/package.json` version is the release input and all named product
   surfaces must already match it. The workflow does not accept a free-form
   version. `nightly` derives an ephemeral version from the committed server
   version, UTC date, and workflow run number.
2. Run `.github/workflows/release.yml` in `prepare` mode. A prepare run may use a
   branch commit, performs no external publication, and rehearses the release by
   uploading reviewable npm, Linux, and macOS artifacts plus SHA-256 files. A
   prepare artifact is not promoted across workflow runs.
3. Review the rehearsal npm tarball and digest. `scripts/inspect-release-package.ts`
   checks the minimal packed manifest and required files, rejects unresolved
   workspace/catalog protocols, private package references, lifecycle scripts,
   and sensitive paths, performs a script-enabled clean-prefix install, and
   executes both `shuv2code --version` and `s2c --version`.
4. Build, install, and verify the matching production iOS app, then distribute
   it through Sqim following [the iOS runbook](./ios-sqim.md).
5. Merge the exact reviewed release commit to `main`, then run the workflow in
   `publish` mode with the Sqim confirmation checked and an operator-written
   release summary. Duplicate npm versions or Git tags fail in `resolve`, before
   package or desktop builds.
6. The publish run builds and uploads a fresh artifact from that immutable main
   SHA, then `publish_npm` pauses at the protected `production` environment.
   Before approving, download and inspect the tarball and SHA-256 from that same
   blocked publish run; compare them with the rehearsal expectations. Approval
   downloads that exact same-run artifact, verifies its SHA-256, and runs npm
   directly against it with the SemVer-derived dist-tag. No step between approval
   and publication rebuilds or invokes a pnpm publish wrapper.
7. The workflow waits until `npm view shuv2code@<version>` returns the exact
   version and verifies the selected dist-tag. Only then can it publish the
   GitHub release and its desktop checksums under `v<version>`.
8. Update and publish `packaging/aur/shuv2code-bin` after replacing `SKIP`
   checksums with the final AppImage and packaging-file hashes. TestFlight is a
   separate, later operator action.

The workflow uses Node 24 and fails if Node is below 22.14.0 or npm is below
11.5.1, disables dependency caching on release jobs, pins every action to a
reviewed commit SHA, and records the immutable source SHA. Generated GitHub notes
are prepended with the operator summary and compare only against the shuv2code
`v0.1.0-alpha.1`-or-later tag line. It does not deploy a hosted web app or relay,
announce to inherited community channels, publish Windows/Android/Intel-macOS
artifacts, or mutate a repository name. The optional relay has a separate manual workflow with a typed
confirmation and protected environment.

## One-time npm trusted-publishing bootstrap

The first public publish is irreversible and remains maintainer-gated. Do not
add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to GitHub.

1. Protect the GitHub `production` environment with a required reviewer and a
   `main`-only deployment policy. If temporary single-maintainer self-review is
   necessary, record the exception and remove it when a second maintainer is
   available.
2. Confirm the unscoped `shuv2code` name is still available immediately before
   publication. Download the exact tarball and `.sha256` from a successful
   prepare run and verify it locally.
3. Authenticate the local npm CLI through browser login and 2FA. Publish that
   tarball once with `npm publish <tarball> --access public --tag next`; never
   bootstrap an alpha onto `latest`.
4. On npm, configure one Trusted Publisher for owner `shuv1337`, repository
   `shuv2code`, workflow `release.yml`, environment `production`, and the
   `npm publish` action.
5. Increment to a second small prerelease and publish it through the protected
   workflow. Verify automatic provenance points to the expected repository,
   workflow run, and source SHA.
6. Set npm Publishing access to require 2FA and disallow tokens. Confirm no npm
   write token exists in repository or environment secrets.

After three supervised releases (bootstrap `next`, OIDC `next`, and a manual
`nightly`), record their source SHA, version, dist-tag, provenance, GitHub release
class, artifact digests, signing result, Sqim evidence, and any recovery in this
runbook before considering a daily schedule.

## Local npm package verification

```bash
vp run --filter shuv2code build
node scripts/apply-web-brand-assets.ts production apps/server/dist/client
mkdir -p release-server
node scripts/prepare-release-package.ts \
  --output release-server/package \
  --version <version>
(cd release-server/package && pnpm pack --pack-destination "$PWD/..")
node scripts/inspect-release-package.ts \
  --tarball release-server/shuv2code-<version>.tgz \
  --version <version> \
  --digest-output release-server/shuv2code-<version>.tgz.sha256
```

Use the `nightly` asset brand for a nightly package. Publication must use the
same inspected tarball bytes; npm versions cannot be overwritten. If a package
is wrong, deprecate it with an explanation and publish a corrected increment.

## Signing inputs

Publication requires Apple signing and notarization inputs. Store these as
protected environment secrets/variables rather than exposing them to branch
prepare runs:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `SHUV2CODE_APPLE_TEAM_ID`
- `MACOS_PROVISIONING_PROFILE`

`SHUV2CODE_CLERK_PASSKEY_RP_DOMAINS` is required only when the signed build
enables configured passkey domains. Release configuration must not introduce a
default hosted endpoint.

## Acceptance checks

- `vp run brand:check`
- `vp run schema:check`
- `vp run icons:check`
- full CI checks
- npm tarball includes README, LICENSE, `dist/bin.mjs`, and
  `dist/client/index.html`, has resolved runtime dependencies, and installs both
  `shuv2code` and `s2c` into a clean prefix
- npm tarball SHA-256 verifies before publication
- protected npm publication uses OIDC and no long-lived npm write token
- AppImage starts and uses `.shuv2code`
- iOS reports `dev.shuv.shuv2code` and the `shuv2code` scheme
- DMG and ZIP signatures validate and notarization is stapled
- no client release precedes the exact npm server version
