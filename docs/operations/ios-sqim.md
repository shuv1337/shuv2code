# iOS Alpha distribution with Sqim

The first shuv2code Alpha reaches iOS through Sqim before any internal
TestFlight rollout.

## What Sqim is

Sqim is a build-and-preview service for iOS apps. Its CLI is distributed as a
Homebrew formula (`milq-ai/tap/sqim`), described upstream as a "Milq CLI for
building Xcode projects on Milq's remote build service". Finished builds are
installed from a hosted webpage and stay reachable from the builds dashboard at
<https://account.sqim.dev/web>.

## Sqim runs on macOS only

The Homebrew formula declares `depends_on :macos` and ships only Darwin
binaries (`sqim_Darwin_arm64`, `sqim_Darwin_x86_64`). There is no Linux build.

This has a direct consequence for automation: **the Sqim step cannot be added
to the existing mobile CI workflows.** Both `mobile-eas-preview.yml` and
`mobile-eas-production.yml` run on `[self-hosted, Linux, X64, shuv-ci,
shuv2code-ci]`, and moving the production job to a macOS runner is not a free
substitution — that workflow's own header documents why production builds must
run on Linux CI: under the fingerprint runtime-version policy the fingerprint
must be computed in the same OS/pnpm as the EAS build, and a macOS `eas build`
computes a different fingerprint and errors.

Note also that Sqim builds an Xcode project on its own remote service rather
than accepting an already-signed `.ipa`. It is a parallel build path, not an
upload sink placed after an EAS build. Treat the Sqim release and the EAS
release as two separate pipelines over the same commit.

Sqim distribution is therefore an operator action performed from a macOS host.

## One-time macOS setup

```sh
brew install milq-ai/tap/sqim
sqim setup all
sqim login
```

`sqim setup all` installs `SKILL.md` files for Claude Code and Codex. **Those
skill files are the authoritative reference for the build and push invocation**
— read them on the macOS host rather than assuming a command shape from this
document.

### Credentials

`sqim login` authenticates the CLI against the operator's Sqim account
(<https://account.sqim.dev>). That is a separate concern from the Apple/team
configuration in step 1 of the release procedure below.

- **No Sqim credential belongs in this repository or in GitHub Actions
  secrets.** The Sqim step is macOS-local and deliberately outside CI, so
  nothing in the release workflows consumes one. Adding a Sqim secret to the
  repository would widen its exposure without enabling anything.
- **Authenticate with an individual operator account rather than a shared
  login,** so builds in the dashboard stay attributable to the person who
  produced them.
- **Apple signing material stays out of git.** `apps/mobile/.gitignore` already
  ignores `*.p8`, `*.p12`, `*.key`, and `*.mobileprovision`, along with the
  generated `/ios` and `/android` directories that step 3 produces. Do not
  force-add any of these.

The credential type `sqim login` prompts for, and where it persists the
resulting session, are not publicly documented. Confirm both with
`sqim login --help` and the installed `SKILL.md` — and check whether the CLI
offers a logout or revoke path — before authenticating on a shared or
long-lived machine.

## Release procedure

1. Set `APP_VARIANT=production` and provide only the Apple/team configuration
   required by the target account.
2. Verify `vp run --filter @shuv2code/mobile config:prod` reports bundle
   identifier `com.shuv2code.app`, the `shuv2code` scheme, and the version
   declared in `apps/mobile/app.config.ts` (currently `0.1.1-alpha.1`).
3. Generate the native iOS project, which Sqim needs as its build input:

   ```sh
   cd apps/mobile
   APP_VARIANT=production EXPO_NO_GIT_STATUS=1 expo prebuild --clean --platform ios
   ```

4. Build and push the app with Sqim, following the installed `SKILL.md`.
5. Install the resulting build from the hosted Sqim page on a representative
   device, pair it with a local shuv2code server, and verify thread creation,
   agent output, theme selection, and reconnect.
6. Record the build identifier and confirmation in the release notes.

The GitHub release workflow requires the operator to confirm the matching Sqim
release before publication. TestFlight remains an explicit later action, driven
by `mobile-eas-production.yml` with `mode=build` (which runs `eas build
--auto-submit`), and only after the Sqim step above is confirmed.
