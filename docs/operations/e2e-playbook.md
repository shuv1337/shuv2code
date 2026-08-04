# Web E2E playbook

This is the minimum browser acceptance pass for a shuv2code web release. Run it
against the production bundle, not only the Vite development server.

## Start

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build
tmp_home="$(mktemp -d /tmp/shuv2code-e2e.XXXXXX)"
SHUV2CODE_HOME="$tmp_home" node apps/server/dist/bin.mjs serve \
  --host 127.0.0.1 --port 0 --base-dir "$tmp_home"
```

Use the printed pairing URL exactly once in an isolated browser profile. Do not
use the shared `~/.shuv2code` directory or a normal browser profile.

## Smoke acceptance

1. **Bootstrap and health**
   - Open the pairing URL in the controlled browser.
   - Confirm the app title is `shuv2code (Alpha)` and the splash screen resolves.
   - Confirm the server responds with HTTP 200 and the browser WebSocket stays connected.
   - Confirm the empty state says `What should we work on?`.
2. **Project lifecycle**
   - Open `Add project`.
   - Confirm `Local folder`, `Git URL`, and configured provider sources are visible.
   - Add a disposable local repository.
   - Confirm the project appears in the sidebar and the app opens a new thread.
   - Reload and confirm the project persists.
3. **Thread composer**
   - Confirm the new-thread heading, project selector, workspace selector, branch selector, model selector, composer, and send button are visible.
   - Enter text in the composer and confirm it can be edited and cleared.
   - With an authenticated provider CLI, send a harmless request and verify user text, assistant output, streaming, stop, retry, and reload persistence.
4. **Thread history**
   - Create a second thread and switch between threads.
   - Verify rename, archive, delete confirmation, restore/archive views, and browser back/forward behavior.
   - Verify archived threads do not appear in the active list.
5. **Source control**
   - In a disposable Git repository, verify current branch, changed-file list, diff view, refresh, commit, and push affordances.
   - With a configured remote, verify a real commit and push only on a disposable branch.
6. **Terminal and files**
   - Open the terminal drawer and run a harmless command such as `pwd`.
   - Verify output, resize/toggle behavior, and session persistence after navigation.
   - Open the file browser, preview a text file, and verify large/binary files fail safely.
7. **Settings and diagnostics**
   - Open Settings and verify General, Appearance, Keybindings, Providers, Automations, Speech, Source Control, Connections, Beta, Archive, and diagnostics navigation.
   - Change one reversible preference, reload, and confirm it persists.
   - Confirm the About section reports the built version.
8. **Responsive and accessibility pass**
   - Repeat the landing, project, composer, and settings assertions at desktop width.
   - Repeat at a representative phone viewport with touch emulation.
   - Check that primary controls have accessible names, focus is visible, dialogs can be dismissed, and no horizontal overflow blocks core actions.
9. **Failure paths**
   - Use an invalid project path and confirm an actionable error.
   - Disconnect or make a provider unavailable and confirm the UI shows a recoverable error rather than hanging.
   - Reload during a pending request and confirm the session reconnects without duplicating the request.

## Evidence and cleanup

Record the commit, package version, build command, server URL, browser profile
type, viewport, pass/fail result for every numbered section, and screenshots for
failures. Never record pairing tokens, cookies, provider credentials, or full
assistant transcripts containing secrets. Stop the production server and remove
only the temporary home/profile created for the run after evidence is captured.

## Current baseline

On 2026-08-02, the production build at commit `640a93b` passed sections 1, 2,
the non-provider portions of 3, 7, and the phone viewport portion of 8 using
Shuvgeist with an isolated Chromium profile. Provider execution, source-control
mutation, terminal/file actions, and failure-path recovery remain follow-up
coverage requiring dedicated disposable fixtures or authenticated CLIs.
