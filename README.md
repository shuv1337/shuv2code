# shuv2code

**The local-first control plane for coding agents.**

shuv2code brings Codex, Claude, Cursor, and OpenCode sessions into one web,
desktop, and mobile workspace. It defaults to local and self-hosted operation:
hosted connection features remain available to operators, but have no implicit
endpoint and stay disabled until explicitly configured.

> [!IMPORTANT]
> shuv2code is Alpha software. The first prepared release is
> `0.1.0-alpha.1`; package and app-store commands below become available only
> after their corresponding release is published.

## Run from source

Install and authenticate at least one supported coding-agent CLI, then:

```bash
vp i
vp run dev
```

The server package publishes as `shuv2code` and installs both `shuv2code` and
the short `s2c` binary. After the npm release exists:

```bash
npx shuv2code@latest
```

## Prepared distribution channels

- Linux: GitHub Release AppImage and `shuv2code-bin` for the AUR
- iOS: Sqim first, then internal TestFlight
- Apple silicon macOS: signed and notarized DMG plus ZIP
- Windows, Android, and Intel macOS: kept buildable, but not published in the
  first Alpha wave

Release publishing, account setup, repository renaming, and hosted deployment
are explicit operator actions; local builds do not perform them.

## Fresh local identity

shuv2code uses `shuv2code.json`, the `SHUV2CODE_*` environment namespace, and
the `.shuv2code` state directory. It intentionally never reads, migrates, warns
about, or deletes legacy `.t3` state. See
[legacy state cleanup](./docs/operations/legacy-state-cleanup.md) if you later
choose to remove that state manually.

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Upstream sync policy](./docs/operations/upstream-sync.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Release runbook](./docs/operations/release.md)

## Project provenance

shuv2code is maintained by
[shuv1337](https://github.com/shuv1337) as a fork of
[T3 Code](https://github.com/pingdotgg/t3code). The fork preserves upstream
license and attribution while using an independent product identity. Upstream
changes are integrated through merge commits so the relationship stays easy to
audit and future syncs remain conflict-conscious.

Contributors need [Vite+](https://viteplus.dev/guide/) and should read
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a change.
