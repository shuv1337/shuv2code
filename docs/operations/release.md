# shuv2code release runbook

The first prepared version is `0.1.0-alpha.1`. Publishing is manual and must
follow this order:

1. Confirm the repository name and distribution accounts.
2. Run the release workflow in `prepare` mode and review the npm tarball, Linux
   AppImage, and Apple silicon DMG/ZIP artifacts.
3. Build, install, and verify the matching production iOS app, then distribute
   it through Sqim following [the iOS runbook](./ios-sqim.md).
4. Run the workflow in `publish` mode with the Sqim confirmation checked.
5. The workflow publishes the exact `shuv2code` server package to npm first,
   using `latest` or `nightly`.
6. Only after npm succeeds does it publish the GitHub prerelease containing the
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
