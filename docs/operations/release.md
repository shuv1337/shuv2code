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
  one patch (`0.1.0` → `0.1.1-nightly...`).

Publishing is manual and must follow this order:

1. Confirm the repository name and distribution accounts.
2. Run the release workflow in `prepare` mode and review the npm tarball, Linux
   AppImage, and Apple silicon DMG/ZIP artifacts.
3. Build, install, and verify the matching production iOS app, then distribute
   it through Sqim following [the iOS runbook](./ios-sqim.md).
4. Run the workflow in `publish` mode with the Sqim confirmation checked.
5. The workflow publishes the exact `shuv2code` server package to npm first,
   using the SemVer-derived dist-tag (`latest`, `next`, or `nightly`).
6. Only after npm succeeds does it publish the GitHub release containing the
   Linux and signed/notarized Apple silicon artifacts.
7. Update and publish `packaging/aur/shuv2code-bin` after replacing `SKIP`
   checksums with the final AppImage and packaging-file hashes.
8. TestFlight is a separate, later operator action.

The workflow does not deploy a hosted web app or relay, announce to inherited
community channels, publish Windows/Android/Intel-macOS artifacts, or mutate a
repository name. The optional relay has a separate manual workflow with a typed
confirmation and protected environment.

## Signing inputs

Publication requires Apple signing and notarization inputs:

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
- npm tarball installs and exposes both `shuv2code` and `s2c`
- AppImage starts and uses `.shuv2code`
- iOS reports `dev.shuv.shuv2code` and the `shuv2code` scheme
- DMG and ZIP signatures validate and notarization is stapled
- no client release precedes the exact npm server version
