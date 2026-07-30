# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` is manual. Prepare mode produces an npm tarball,
  Linux x64 AppImage, and Apple silicon DMG/ZIP without publishing. Publish mode
  requires an iOS Sqim confirmation, publishes the exact npm server first with the
  SemVer-derived dist-tag (`latest` / `next` / `nightly`), then creates a GitHub
  release. See [Release Checklist](./release.md) for channel rules.
- Published macOS artifacts require the complete Apple signing and notarization
  configuration. Windows, Android, and Intel macOS remain buildable but are not
  published in the first Alpha wave.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
