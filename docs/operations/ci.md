# CI quality gates

- `.github/workflows/ci.yml` is a single self-hosted job for personal-project
  speed: brand/schema/icon checks and `vp check` (format + lint; typecheck is
  off in the lint options) on pull requests and pushes to `main`. Target wall
  clock is a few minutes, not a full monorepo matrix.
- It deliberately does **not** run the full unit/integration suite, typecheck,
  desktop builds, mobile native lint, or signed package builds on every PR.
  The manual release workflow `verify` job runs `vp check`, typecheck, full
  tests, `release-smoke`, resource-monitor cargo fmt/test, and mobile config
  production/preview validation. Desktop package builds and signed macOS
  builds stay on the release pack/platform jobs.
- The main branch ruleset requires only that one `CI` check, with admin bypass
  allowed and without requiring branches to be up to date with main.
- Local focused tests remain the day-to-day signal; see `AGENTS.md`.
- `.github/workflows/release.yml` is the sole manual npm publishing workflow.
  Prepare mode resolves the committed named version (or derives a nightly), runs
  verification once, stages a minimal npm manifest, builds one npm tarball,
  performs a script-enabled clean install of both CLI names, and uploads the
  tarball and desktop artifacts with SHA-256 files. Publish mode is
  `main`-only, requires iOS Sqim confirmation and approval through the protected
  `production` environment. The reviewer inspects the tarball and digest from that
  same blocked publish run before approval; the job then verifies the downloaded
  bytes, publishes directly with npm OIDC and the SemVer-derived dist-tag
  (`latest` / `next` / `nightly`), proves the exact npm version is observable,
  and only then creates the GitHub release with an operator summary and an
  explicit shuv2code-line previous tag. Release jobs do not use dependency caches or npm write
  tokens. See [Release Checklist](./release.md) for channel and bootstrap rules.
- Published macOS artifacts require the complete Apple signing and notarization
  configuration. Windows, Android, and Intel macOS remain buildable but are not
  published in the first Alpha wave.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
