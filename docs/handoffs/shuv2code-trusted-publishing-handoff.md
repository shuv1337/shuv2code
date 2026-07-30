# Handoff: shuv2code npm trusted-publishing bootstrap

- **Written:** 2026-07-30T18:43Z
- **Repo:** `/home/shuv/repos/shuv2code` (`origin` = `shuv1337/shuv2code`)
- **Local branch:** `main` @ `c5acae7b6` (matches `origin/main`)
- **Transfer branch:** `agent/trusted-publishing-handoff`
- **Primary tracker:** https://github.com/shuv1337/shuv2code/issues/7
- **Runbook:** `docs/operations/release.md`
- **Workflow:** `.github/workflows/release.yml`

## Goal for next session

Finish npm trusted-publishing setup for the unscoped package `shuv2code`:

1. Bootstrap-publish `0.1.0-alpha.1` with tag `next` from the **exact** verified prepare-run tarball.
2. Configure one Trusted Publisher on npm pointing at GitHub Actions.
3. (If time) OIDC proof via a second prerelease; then lock publishing access. Do **not** close #7 until Done When is actually met.

This is **not** a greenfield design task. The release system already exists; the remaining work is operational + one irreversible first publish.

## Current state (verified just now)

| Fact                          | Value                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Package on npm                | **Still missing** (`npm view shuv2code` → E404)                                                  |
| npm CLI identity              | `kcrommett` (`npm whoami` succeeds)                                                              |
| Committed product version     | `0.1.0-alpha.1` (`apps/server/package.json`)                                                     |
| GitHub `production` env       | Reviewer `shuv1337`, self-review allowed, branch policy `main` only                              |
| Latest successful prepare run | https://github.com/shuv1337/shuv2code/actions/runs/30569079395 on `c5acae7b6`                    |
| Prepare jobs                  | resolve ✓, verify ✓, pack_npm ✓, linux AppImage ✓, macos arm64 ✓; publish jobs correctly skipped |
| Downloaded bootstrap tarball  | `/tmp/shuv2code-bootstrap-final/shuv2code-0.1.0-alpha.1.tgz`                                     |
| SHA-256                       | `2d4407a93db9ddb1c0120657c16537165a5acbf93719b5c2e7cb749725febadd`                               |
| Inspect result                | 812 files, digest re-verified via `scripts/inspect-release-package.ts`                           |
| Dry-run publish               | Succeeded: id `shuv2code@0.1.0-alpha.1`, tag `next`, public                                      |
| Real publish attempt          | **Failed with EOTP** — needs browser one-time auth; URL was redacted in logs                     |
| Shuvgeist                     | Extension **disconnected** (no browser target). Relaunch required before npm UI work.            |

Do **not** invent a long-lived `NPM_TOKEN` / `NODE_AUTH_TOKEN` GitHub secret. Bootstrap is local CLI + OIDC thereafter.

## Continuation checkpoint

The next session began the cheap preflight and then stopped before another publish attempt:

- `npm whoami` still returned `kcrommett`.
- `npm view shuv2code version` still returned E404.
- `origin/main` and the successful prepare run still resolved to `c5acae7b6`.
- The tarball still inspected as 812 files with SHA-256 `2d4407a93db9ddb1c0120657c16537165a5acbf93719b5c2e7cb749725febadd`.
- `scripts/inspect-release-package.ts` now requires `--digest-output <path>` in addition to the flags shown below.
- Shuvgeist eventually connected after the launch command timed out, but the agent-launched browser was no longer running at transfer time. Start from `shuvgeist status --json` again.
- No npm version was published and no npm or GitHub settings were changed.

## What already landed on main this session (do not redo)

Gate-fix commits, in order:

1. `a6eb6711d` — desktop readiness typed error + Schema fixtures (PR #15)
2. `b000126e0` — server Path context + OpenCode status probe + timer diagnostics (PR #17)
3. `9ba5cab5e` — keep raw `toolData` MCP-only so projection parity holds (PR #24)
4. `1f6d2c4df` — release pack uses `npm pack` (not missing `pnpm`) (PR #30; pushed via FF after GitHub merge-queue 502)
5. `c5acae7b6` — install ImageMagick on Linux release runner (PR #33)

Also already on main from earlier triage (same day, prior turns):

- Tool-result images polish: `aeb517c35`
- Project automations: `4540716f0`
- Automation lifecycle discussion draft: `87399cb1e`
- Issue #1 (composer prompt history) closed as already implemented

## Immediate next steps (ordered)

### 1. Reconnect browser automation

```bash
shuvgeist status --json
# If extension.connected=false:
shuvgeist launch --url https://www.npmjs.com --foreground
shuvgeist status --json   # must show connected extension + tabs
```

Use the **default Shuvgeist profile** (persistent under `~/.shuvgeist/profile/...`) so npm login cookies can persist. Prefer semantic `snapshot` / `locate` / `ref` over brittle selectors.

### 2. Re-verify bootstrap inputs (cheap)

```bash
cd /home/shuv/repos/shuv2code
npm whoami
npm view shuv2code version || true   # expect 404 still
(cd /tmp/shuv2code-bootstrap-final && sha256sum -c shuv2code-0.1.0-alpha.1.tgz.sha256)
# If /tmp artifact missing, re-download from the successful prepare run only:
# gh run download 30569079395 -R shuv1337/shuv2code -n shuv2code-npm-0.1.0-alpha.1 -D /tmp/shuv2code-bootstrap-final
node scripts/inspect-release-package.ts \
  --tarball /tmp/shuv2code-bootstrap-final/shuv2code-0.1.0-alpha.1.tgz \
  --version 0.1.0-alpha.1 \
  --digest-output /tmp/shuv2code-bootstrap-final/rechecked.sha256
```

Publish **only** that absolute path. Relative tarball paths are misread by npm as GitHub shorthands (`EALLOWGIT`).

### 3. Bootstrap publish (irreversible)

```bash
npm publish /tmp/shuv2code-bootstrap-final/shuv2code-0.1.0-alpha.1.tgz \
  --access public --tag next
```

Expect **EOTP** again. When npm prints a browser URL:

1. Open it with Shuvgeist (`navigate` / new tab).
2. Complete WebAuthn / security-key — **user must physically approve**.
3. Re-run publish if the CLI does not resume automatically.

Post-publish checks:

```bash
npm view shuv2code@0.1.0-alpha.1 version
npm view shuv2code dist-tags --json
# expect: next=0.1.0-alpha.1, latest absent or not pointing at alpha
# clean install smoke if desired (temp prefix + both shuv2code and s2c --version)
```

Never put alpha on `latest`.

### 4. Configure Trusted Publisher (Shuvgeist)

Once the package exists, open:

`https://www.npmjs.com/package/shuv2code/access`

Configure **exactly one** Trusted Publisher:

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Provider          | GitHub Actions                |
| Owner             | `shuv1337`                    |
| Repository        | `shuv2code`                   |
| Workflow filename | `release.yml` (basename only) |
| Environment       | `production`                  |

Reference UI was inspected earlier on an existing package (`@shuv1337/pi-coding-agent/access`): fields are `oidc-repositoryOwner`, `oidc-repositoryName`, `oidc-workflowName`, `oidc-githubEnvironmentName`. Save only after snapshot confirms values. Do not edit unrelated packages.

**Do not** lock “require 2FA and disallow tokens” until after a successful OIDC proof publish (runbook step 6 after step 5).

### 5. OIDC proof (second prerelease)

After trust is configured:

1. Bump committed product version to `0.1.0-alpha.2` via `scripts/update-release-package-versions.ts` in a normal PR (named releases must match server/web/desktop/mobile).
2. Merge to `main`.
3. Run prepare → review artifact.
4. Run publish mode. **Do not** falsely set `ios_sqim_release_confirmed` — if publish is blocked on Sqim, stop and ask; do not lie to the workflow.
5. Approve the GitHub `production` environment deployment when prompted.
6. Verify provenance on npm package page points at `shuv1337/shuv2code` + `release.yml` + expected SHA.
7. Then set npm Publishing access to require 2FA / disallow tokens; confirm no npm write secrets in GitHub.

### 6. Issue #7 hygiene

Update https://github.com/shuv1337/shuv2code/issues/7 with:

- bootstrap version, dist-tag, source SHA, prepare run URL, tarball SHA-256
- trusted publisher fields
- OIDC proof status (or explicit remaining)

Keep open until three supervised releases are recorded (bootstrap `next`, OIDC `next`, manual `nightly`) per runbook.

## Failed prepare runs (for context only)

| Run             | SHA           | Failure                                                                       |
| --------------- | ------------- | ----------------------------------------------------------------------------- |
| 30560262066     | 87399cb1e     | Desktop Effect typecheck                                                      |
| 30563239600     | a6eb6711d     | Server Path/OpenCode typecheck                                                |
| 30564199054     | b000126e0     | Full suite: projection parity (toolData bulk)                                 |
| 30565684796     | 9ba5cab5e     | `pnpm: command not found` in pack job                                         |
| 30567254212     | 1f6d2c4df     | Linux: ImageMagick missing (`magick`/`convert`) — **npm artifact still good** |
| **30569079395** | **c5acae7b6** | **All prepare jobs green**                                                    |

## Safety / constraints

- First npm version is immutable; wrong publish → deprecate + new version, never overwrite.
- No long-lived npm tokens in GitHub.
- One trusted publisher only; identity must match `release.yml` + `production`.
- Publish absolute tarball paths only.
- Do not mutate existing `@shuv1337/*` packages’ trusted publishers while using them as UI reference.
- Redact auth tokens, cookies, OTP URLs with secrets in logs/comments.
- Many unrelated open draft PRs (#21–#32 memory/backpressure work) are **out of scope** unless the user redirects.

## Suggested skills (invoke early)

1. **shuvgeist** — browser login, EOTP approval, npm Trusted Publisher UI.
2. **context-management** — long ops phase (prepare → publish → UI); checkpoint at phase boundaries if multi-hour.
3. **diagnose** — only if prepare/publish/OIDC fails again; minimal red case first.
4. **handoff** — if stopped mid-bootstrap again.

Optional later: `code-review` only if a non-trivial code fix is required beyond workflow/env glue.

## Useful commands cheat sheet

```bash
# Status
gh run view 30569079395 -R shuv1337/shuv2code
gh api repos/shuv1337/shuv2code/environments --jq '.environments[]|{name,protection_rules}'

# Re-download final npm artifact
gh run download 30569079395 -R shuv1337/shuv2code \
  -n shuv2code-npm-0.1.0-alpha.1 -D /tmp/shuv2code-bootstrap-final

# Local pack path (for non-official experiments only — do NOT bootstrap from local rebuild)
# Prefer the GH artifact above for the irreversible first publish.

# Browser
shuvgeist launch --url https://www.npmjs.com --foreground
shuvgeist snapshot --json
shuvgeist locate role button --name "Use security key" --json
```

## Stop conditions / ask the user

- Physical security-key / passkey / 2FA gestures.
- Whether to proceed with OIDC proof **without** Sqim iOS confirmation (workflow currently hard-blocks publish without it).
- Whether temporary self-review on `production` remains acceptable.
- Closing #7 before three supervised releases.

## Explicit non-goals for the next agent

- Redesigning SemVer/channel policy (already implemented).
- Re-litigating tool images / automations features unless they break release again.
- Merging the open draft memory/backpressure PR stack unless requested.
- Adding Changesets / multi-package npm publishing.
