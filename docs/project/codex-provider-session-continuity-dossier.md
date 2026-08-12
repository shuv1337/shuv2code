# Prompt Dossier: Codex Provider Session Continuity and Pathological Resume Latency

**Prepared:** 2026-08-12  
**Audience:** A fresh engineering agent with no prior conversation context  
**Repository:** <https://github.com/shuv1337/shuv2code>  
**Observed baseline revision:** [`031b7464289cebd05a973d7244767cf982566710`](https://github.com/shuv1337/shuv2code/tree/031b7464289cebd05a973d7244767cf982566710)  
**Status:** Investigation dossier, not an approved implementation specification

---

## Mission prompt for the next agent

You are investigating a shuv2code architectural regression involving durable shuv2code threads and their replaceable provider-native sessions.

A user-visible shuv2code thread is durable application state. Its backing Codex thread is a provider implementation detail. The current implementation can nevertheless keep resuming the same Codex thread indefinitely. One observed Codex rollout grew to 880,712,014 bytes and caused a measured `thread/resume` operation to take roughly 216 seconds. The user was left looking at a connecting state while Codex reconstructed that provider-native history.

Do not solve this by telling the user to create a new shuv2code thread. Do not delete or rewrite historical state without explicit approval. Preserve the visible shuv2code thread, timeline, workspace, checkpoints, and identity. Investigate and design transparent provider-session rollover beneath that same durable thread, using bounded continuity context derived from shuv2code-owned state.

Before changing code:

1. Read `AGENTS.md`, `PRODUCT.md`, `HANDOFF.md`, `docs/internals/providers.md`, and the provider-runtime portion of `docs/internals/glossary.md`.
2. If working in an existing checkout, inspect its dirty state and preserve unrelated work. The source-machine checkout used for this investigation contained unrelated provider/voice modifications; a fresh clone will not contain them.
3. Reproduce and verify the commit history in this dossier rather than accepting every causal statement blindly.
4. Separate the provider-resume problem from the desktop blank-window/reusable-server-probe problem. They are both startup UX defects, but they have different causes and fixes.
5. Produce a verified architecture and implementation plan before coding. Add tests before changing lifecycle behavior.

---

## Executive summary

shuv2code has two different lifecycle layers:

1. **shuv2code thread** — the durable, user-visible conversation and workspace history owned by shuv2code.
2. **Provider-native session/thread** — the live Codex, Claude, Cursor, Grok, or OpenCode runtime attached behind the shuv2code thread.

The intended abstraction is that clients address a shuv2code thread and the provider runtime remains replaceable. Current behavior leaks provider durability into the product model:

```text
Durable shuv2code thread
        ↓
Persisted Codex resume cursor
        ↓
The same Codex thread is resumed repeatedly
        ↓
Its append-only rollout keeps growing
        ↓
Codex reconstructs the entire provider artifact during thread/resume
        ↓
shuv2code waits synchronously for the resume operation
```

The pathological backing rollout is currently approximately 880 MB. Direct testing showed that Codex thread resume took roughly 216 seconds. Direct XcodeBuildMCP initialization took only about 1.1 seconds, so that MCP server does not explain the multi-minute delay.

The repository originally contained a fallback mechanism that detected a fresh/replacement Codex thread and sent it a bounded transcript assembled from shuv2code history. During the frontend-to-orchestration migration, the production caller was removed and equivalent server-side behavior was not added. Later commits made persisted resume-cursor reuse implicit and carried synchronous `thread/resume` into the current Codex runtime.

The core working hypothesis is therefore:

> The problem is an architectural regression introduced incrementally: transparent fresh-provider continuity was removed, while durable cursor persistence and automatic resume were strengthened. This accidentally welded one shuv2code thread to one ever-growing Codex thread without a rollover policy.

This hypothesis is high confidence but should still be audited against the complete ancestry and current tests before implementation.

---

## User-visible manifestation

### Symptom A: desktop appears late

Observed desktop cold-start sequence:

- The AppImage process starts.
- `DesktopLocalServerAttach.discoverReusableLocalServer()` probes for a reusable backend for approximately 8 seconds.
- Backend startup/readiness then takes approximately another 2.4 seconds.
- The main window does not appear until roughly 14 seconds after process launch.

This is a desktop startup-shell problem. The preferred UX is to render a local full-size shell/skeleton immediately and perform backend discovery/startup asynchronously.

Relevant files:

- `apps/desktop/src/app/DesktopApp.ts`
- `apps/desktop/src/backend/DesktopLocalServerAttach.ts`
- `apps/desktop/src/backend/DesktopLocalServerAttach.test.ts`
- `apps/desktop/src/window/DesktopWindow.ts`

### Symptom B: Codex remains connecting for minutes

When shuv2code starts or reattaches the Codex runtime for the affected visible thread:

- shuv2code retrieves the persisted provider resume cursor;
- the Codex adapter issues `thread/resume` for that exact provider-native thread;
- Codex reconstructs the corresponding rollout;
- shuv2code waits for the RPC before treating the provider session as ready;
- measured wait: roughly 216 seconds.

This is the core issue addressed by this dossier.

### Do not conflate the two symptoms

```text
~8 seconds   Desktop reusable-server discovery before UI creation
~2.4 seconds Backend startup/readiness
~216 seconds Codex reconstruction of an enormous provider-native thread
~1.1 seconds Direct XcodeBuildMCP initialization
```

The desktop shell can and should be improved independently. It does not fix pathological provider resume.

---

## Concrete incident evidence

### Pathological Codex rollout

The artifact existed only on the source machine and is not stored in the Git repository:

```text
~/.codex/sessions/2026/08/10/
  rollout-2026-08-10T21-31-12-019fed5f-478e-7d53-a36a-27b53221b485.jsonl
```

A remote agent should treat the measurements below as incident evidence. It cannot re-read the artifact unless the user separately provides or mounts it.

Snapshot captured on 2026-08-12:

```text
Size:       880,712,014 bytes
Line count: 18,703
Modified:   2026-08-12 08:56:50 +0100
```

Earlier inspection estimated its major content categories at approximately:

```text
357 MB compacted snapshots
314 MB response items
167 MB events
```

Those category totals are investigative estimates, not a schema guarantee. Recalculate them before relying on exact values.

Important distinction:

- the thread's current effective context was observed at roughly 178k tokens;
- approximately 414 million tokens represented cumulative processing over the thread lifetime;
- the 880 MB file is an append-only historical artifact containing repeated events and snapshots, not 880 MB of unique current prompt context.

### shuv2code state size

Snapshot captured on 2026-08-12:

These files also existed only on the source machine and are not part of the remote repository:

```text
~/.shuv2code/userdata/state.sqlite  2,114,285,568 bytes
~/.config/shuv2code                 3,415,443,598 bytes
```

Earlier database inspection found:

```text
orchestration_events                ~1.25 GB
activity-event payloads             ~1.08 GB
observed backend RSS                ~2.1 GB
```

This is a separate but related retention/compaction concern. It proves shuv2code owns substantial canonical history, but it does not by itself define the correct continuity packet for a replacement provider session.

### XcodeBuildMCP and Excalidraw findings

XcodeBuildMCP is introduced by the cached Codex **Build iOS Apps** plugin:

Source-machine cache location:

```text
~/.codex/plugins/cache/openai-curated-remote/
  build-ios-apps/0.1.2/.mcp.json
```

Its command is:

```json
{
  "command": "npx",
  "args": ["-y", "xcodebuildmcp@latest", "mcp"]
}
```

Direct initialization took approximately 1.1 seconds. It may add some startup overhead, but it is not the cause of the 216-second connection.

Excalidraw was unavailable and has been disabled in the user Codex configuration:

```toml
[mcp_servers.excalidraw]
url = "http://127.0.0.1:38758/mcp"
enabled = false
```

Source-machine configuration file:

```text
~/.codex/config.toml
```

Do not modify further user or system configuration unless explicitly requested.

---

## Intended architecture

Repository documentation describes shuv2code as a provider-neutral control plane.

Key concepts:

- `docs/internals/glossary.md` defines a **Thread** as the durable unit of conversation and workspace history.
- The same glossary defines a **Session** as the live provider-backed runtime attached to a thread.
- `docs/internals/providers.md` states that `ProviderService` routes operations by shuv2code thread so callers name a thread, not an agent.
- Provider-facing work is requested through orchestration commands; clients do not call providers directly in the current architecture.

The lifecycle should therefore permit:

```text
Shuv thread A (durable and user-visible)
    ├── Codex provider thread generation 1 (retired)
    ├── Codex provider thread generation 2 (retired)
    └── Codex provider thread generation 3 (active)
```

A replacement provider thread must not require:

- a new visible shuv2code thread;
- a new workspace or worktree;
- loss of messages, activities, checkpoints, or diffs;
- exposing provider-specific lifecycle management to the user.

---

## Current runtime behavior

### 1. Persisted resume cursor is selected implicitly

At the observed baseline revision [`031b7464`](https://github.com/shuv1337/shuv2code/tree/031b7464289cebd05a973d7244767cf982566710), `ProviderService.startSession()` reads the persisted binding and uses its resume cursor unless recovery is explicitly forbidden or a cursor was supplied in the request.

File:

[`apps/server/src/provider/Layers/ProviderService.ts`](https://github.com/shuv1337/shuv2code/blob/031b7464289cebd05a973d7244767cf982566710/apps/server/src/provider/Layers/ProviderService.ts)

Relevant logic near lines 693–700 of the observed baseline revision:

```ts
const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
const effectiveResumeCursor =
  input.recoveryPolicy === "forbid"
    ? undefined
    : (input.resumeCursor ??
      (persistedBinding?.providerInstanceId === resolvedInstanceId
        ? persistedBinding.resumeCursor
        : undefined));
```

The effective cursor is then passed to the adapter near lines 764–770:

```ts
const session = yield* adapter.startSession({
  ...input,
  providerInstanceId: resolvedInstanceId,
  ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
  ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
});
```

Meaning in plain English:

> Starting the provider for an existing shuv2code thread silently resumes its previously bound provider-native thread by default.

### 2. Codex waits for `thread/resume`

File:

[`apps/server/src/provider/Layers/CodexSessionRuntime.ts`](https://github.com/shuv1337/shuv2code/blob/031b7464289cebd05a973d7244767cf982566710/apps/server/src/provider/Layers/CodexSessionRuntime.ts)

`openCodexThread()` selects `thread/start` only when no provider thread ID exists. Otherwise it awaits:

```ts
client.request("thread/resume", {
  threadId: resumeThreadId,
  ...commonParams,
});
```

`makeCodexSessionRuntime()` supplies:

```ts
resumeThreadId: readResumeCursorThreadId(options.resumeCursor)
```

The session is not returned as ready until the thread-open request resolves.

### 3. Fallback is error-based, not health/size/latency-based

`openCodexThread()` can fall back to `thread/start` for errors classified as recoverable resume failures. A valid but extremely slow resume is not an error. There is currently no known policy that says:

- the rollout is too large;
- reconstruction exceeded a latency budget;
- this provider session has exceeded a lifetime/turn/byte threshold;
- rotate to a fresh provider-native thread and hand over bounded context.

### 4. Bounded transcript bootstrap exists but has no production caller

Files:

- [`apps/web/src/historyBootstrap.ts`](https://github.com/shuv1337/shuv2code/blob/031b7464289cebd05a973d7244767cf982566710/apps/web/src/historyBootstrap.ts)
- [`apps/web/src/historyBootstrap.test.ts`](https://github.com/shuv1337/shuv2code/blob/031b7464289cebd05a973d7244767cf982566710/apps/web/src/historyBootstrap.test.ts)

`buildBootstrapInput()` can construct a bounded transcript, report omitted messages, truncate when necessary, and preserve the latest user request.

Current search result:

```bash
rg -n 'buildBootstrapInput' apps/web/src \
  --glob '!historyBootstrap.ts' \
  --glob '!historyBootstrap.test.ts'
```

returns no callers.

The helper is therefore tested but unused in the production flow.

---

## Commit archaeology

The following commits form a direct ancestry chain in the current repository:

```text
57f5b836 → 36802d70 → bb8a8444 → 77716b4c → 3b98fe35
```

Verify with:

```bash
for pair in \
  '57f5b836 36802d70' \
  '36802d70 bb8a8444' \
  'bb8a8444 77716b4c' \
  '77716b4c 3b98fe35'
do
  set -- $pair
  git merge-base --is-ancestor "$1" "$2" && echo "$1 -> $2"
done
```

### Commit 1: original durable continuity and fallback

```text
57f5b8362a3ef5d8499307ab04da2ae38fb84e20
Author: Theo Browne
Author date: 2026-02-09T01:41:01-08:00
Subject: Add durable Codex thread continuity and history bootstrap fallback
```

GitHub:

```text
https://github.com/shuv1337/shuv2code/commit/57f5b8362a3ef5d8499307ab04da2ae38fb84e20
```

This commit added:

- a prior Codex thread ID on the visible thread;
- an attempt to resume that provider-native thread;
- continuity states: `resumed`, `new`, and `fallback_new`;
- `buildBootstrapInput()`;
- bounded transcript bootstrap when a visible thread had history but the provider session was new or had fallen back to fresh.

Representative old flow:

```ts
const shouldBootstrap =
  previousMessages.length > 0 &&
  (sessionInfo.continuityState === "new" ||
    sessionInfo.continuityState === "fallback_new");

const input = shouldBootstrap
  ? buildBootstrapInput(
      previousMessages,
      trimmed,
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    ).text
  : trimmed;
```

Interpretation:

> The original design explicitly allowed a fresh Codex thread to continue the same visible conversation by receiving bounded history.

Inspect:

```bash
git show 57f5b836 -- \
  apps/renderer/src/components/ChatView.tsx \
  apps/renderer/src/historyBootstrap.ts
```

### Commit 2: orchestration migration removes production bootstrap caller

```text
36802d707df879e6f5d635f4ec3f89d50045ae20
Author: Julius Marminge
Author date: 2026-02-24T09:52:38-08:00
Commit date: 2026-02-26T13:20:36-08:00
Subject: frontend
```

GitHub:

```text
https://github.com/shuv1337/shuv2code/commit/36802d707df879e6f5d635f4ec3f89d50045ae20
```

This commit moved turn submission from direct provider calls to orchestration:

```ts
await api.orchestration.dispatchCommand({
  type: "thread.turn.start",
  ...
});
```

In that migration it removed:

- the `buildBootstrapInput` import;
- `continuityState` handling in the send path;
- conditional bounded transcript construction;
- the direct provider `sendTurn()` call carrying that constructed input.

The helper and tests remained in the repository, but equivalent behavior was not moved into the server-side orchestration/provider flow.

This is the strongest candidate for the functional regression point.

Inspect:

```bash
git show 36802d70 -- apps/web/src/components/ChatView.tsx
```

### Commit 3: thread-bound provider sessions and preserved cursors

```text
bb8a8444f4c9e1b4e9ad6c33c9a3c0e020f1b6c7
Author: Julius Marminge
Author date: 2026-02-25T23:38:02-08:00
Commit date: 2026-02-26T13:20:36-08:00
Subject: Bind provider sessions to thread IDs and preserve resume cursors
```

GitHub:

```text
https://github.com/shuv1337/shuv2code/commit/bb8a8444f4c9e1b4e9ad6c33c9a3c0e020f1b6c7
```

This commit:

- required a shuv2code `threadId` when starting provider sessions;
- persisted provider-native `resumeCursor`/`providerThreadId` data;
- routed stale-session recovery through persisted bindings;
- preserved bindings so sessions could resume after process restart.

This behavior is not inherently wrong. Durable cursor persistence is useful. It became dangerous because the transparent fresh-session bootstrap path had already been removed and no rollover policy replaced it.

Inspect:

```bash
git show bb8a8444 -- \
  apps/server/src/provider/Layers/ProviderService.ts \
  apps/server/src/codexAppServerManager.ts
```

### Commit 4: persisted cursor reuse becomes implicit on start

```text
77716b4ccb529b635730e30a4ca94f5affe9db24
Author: Julius Marminge
Author date: 2026-03-19T19:54:21-07:00
Commit date: 2026-03-20T02:54:21Z
Subject: feat: add Claude Code adapter (#179)
```

GitHub:

```text
https://github.com/shuv1337/shuv2code/commit/77716b4ccb529b635730e30a4ca94f5affe9db24
```

Among broader provider work, this commit added the automatic fallback from an explicitly supplied cursor to the cursor stored in the shuv thread's provider binding:

```ts
const effectiveResumeCursor =
  input.resumeCursor ??
  (persistedBinding?.provider === input.provider
    ? persistedBinding.resumeCursor
    : undefined);
```

Interpretation:

> A caller no longer had to request provider resume explicitly. Starting the provider for an existing shuv thread would silently resume the persisted provider-native thread.

This is the strongest candidate for making unbounded provider-thread reuse effectively unconditional.

Inspect:

```bash
git show 77716b4c -- apps/server/src/provider/Layers/ProviderService.ts
```

### Commit 5: current synchronous Codex resume path

```text
3b98fe3548831c536cf8c22d4b8a63e03e0a7d58
Author: Julius Marminge
Author/commit date: 2026-04-19T21:46:40-07:00
Subject: `effect-codex-app-server` (#1942)
```

GitHub:

```text
https://github.com/shuv1337/shuv2code/commit/3b98fe3548831c536cf8c22d4b8a63e03e0a7d58
```

This introduced `CodexSessionRuntime` and the current basic decision:

```ts
if (resumeThreadId === undefined) {
  return input.client.request("thread/start", startParams);
}

return input.client.request("thread/resume", {
  threadId: resumeThreadId,
  ...startParams,
});
```

It preserved error-based fallback to fresh start, but provider readiness still waits for resume to finish. Valid-but-pathologically-slow resume therefore blocks connection.

Inspect:

```bash
git show 3b98fe35 -- \
  apps/server/src/provider/Layers/CodexSessionRuntime.ts
```

---

## Causal assessment

### Verified facts

- The affected Codex rollout is approximately 880 MB.
- Direct Codex `thread/resume` for the affected thread took approximately 216 seconds.
- Direct XcodeBuildMCP startup took approximately 1.1 seconds.
- shuv2code persists provider resume state against durable shuv threads.
- `ProviderService.startSession()` currently reuses a matching persisted cursor by default.
- Codex session startup currently waits for `thread/resume`.
- The old frontend used `buildBootstrapInput()` for new/fallback provider sessions.
- The orchestration migration removed that production call.
- `buildBootstrapInput()` currently has no production caller.
- No provider-session size, age, turn-count, or resume-latency rollover policy has been identified.

### High-confidence working hypothesis

The regression was introduced incrementally:

1. `57f5b836` established correct fresh-provider continuity under the same visible thread.
2. `36802d70` moved sending to orchestration but dropped bounded bootstrap behavior.
3. `bb8a8444` strengthened durable shuv-thread-to-provider-cursor binding.
4. `77716b4c` made persisted cursor reuse implicit on provider start.
5. `3b98fe35` carried that policy into a synchronous Codex `thread/resume` readiness path.
6. Because no rollover policy exists, the provider-native rollout can grow indefinitely and eventually dominate connection time.

### Claims that still require verification

- Whether any server-side history handoff existed briefly on another branch or was later removed.
- Whether current Codex app-server versions expose rollout metadata that can be queried cheaply before resume.
- Whether timeout/cancellation of `thread/resume` safely leaves the app-server process reusable.
- Whether current provider bindings can represent multiple generations without a schema migration.
- Which portion of shuv2code's canonical timeline should seed a replacement provider session.
- Whether the replacement handoff should be a visible user message, hidden developer instruction, provider-specific initial history, or a new provider-neutral contract.
- Whether resume can be moved fully off the UI critical path without violating turn ordering or startup recovery.

Do not present those unresolved points as established facts.

---

## Correct product direction

The user-visible shuv2code thread must remain stable while its provider-native backing session can rotate.

Expected conceptual flow:

```text
User sends/opens shuv thread A
        ↓
Provider binding is healthy and cheap to resume?
        ├── yes → resume current provider generation
        └── no  → create replacement provider generation
                        ↓
                 seed bounded continuity packet
                        ↓
                 atomically bind new cursor
                        ↓
                 continue in shuv thread A
```

A continuity packet may need:

- current objective and status;
- bounded recent conversation suffix;
- durable decisions and constraints;
- current workspace/worktree identity;
- current checkpoint/diff state;
- unresolved tasks and latest user request;
- explicit notice that older context was omitted;
- enough provenance to audit which shuv state generated it.

That list is a starting hypothesis, not an approved schema.

---

## Required design questions

### Detection and policy

- What makes a provider session unhealthy enough to rotate?
- Can Codex rollout size be determined without opening/reconstructing it?
- Should rotation use bytes, age, turn count, cumulative tokens, resume duration, or a combination?
- What global resume deadline is safe?
- Should a timeout immediately create a replacement or ask the user?
- How are thresholds provider-neutral while still permitting Codex-specific health signals?

### Continuity source

- Which shuv2code projection/event data is authoritative for continuity?
- How are messages, tool results, activities, checkpoints, diffs, and attachments represented?
- How is the latest user request guaranteed to survive truncation?
- Is a recent transcript sufficient, or must shuv2code maintain a durable rolling summary?
- How is stale or contradictory summary material detected?

### Provider-generation model

- Does the binding schema need explicit generation records?
- How are active and retired provider cursors represented?
- How is new binding publication atomic with successful provider creation?
- What happens if the new session starts but binding persistence fails?
- What happens if the process crashes between creation, bootstrap, and binding?
- Can multiple clients race to rotate the same thread?

### User experience

- Should rollover be completely silent, shown as an activity, or shown only on failure?
- Can the canonical timeline render before provider readiness?
- Can the composer remain available while provider resume/rollover runs?
- What is the retry and cancellation experience?
- How does the UI distinguish backend connection, provider connection, and active turn processing?

### Provider semantics

- Does a fresh provider thread lose provider-generated compaction summaries not represented in shuv2code?
- How should MCP/tool configuration be applied to the replacement session?
- Should historical plugin/MCP activation leak into a replacement session?
- How do runtime mode, interaction mode, model, effort, CWD, and worktree survive rotation?
- How do checkpoint revert and provider-native rollback behave across generations?

### Retention and audit

- Are retired Codex rollouts retained, archived, compressed, or eventually pruned?
- What user consent is required before deleting provider-owned history?
- What diagnostic metadata should be persisted without copying huge payloads into orchestration events?
- How does shuv2code prevent its own `state.sqlite` event payloads from growing without bound?

---

## Implementation constraints

The eventual implementation must:

- preserve the same visible shuv2code thread ID;
- preserve workspace/worktree and checkpoint history;
- avoid blind deletion or mutation of the 880 MB rollout;
- retain provider-neutral orchestration boundaries where practical;
- avoid making clients call providers directly again;
- bound continuity input deterministically;
- be idempotent under retries and crashes;
- handle concurrent turn-start attempts safely;
- emit enough observability to distinguish resume, rollover, bootstrap, and failure;
- add focused tests before changing lifecycle behavior;
- preserve all unrelated dirty working-tree files when operating in an existing checkout.

It must not:

- tell the user to abandon the visible thread;
- treat XcodeBuildMCP as the primary cause;
- treat a fresh provider thread as a fresh shuv2code conversation;
- rely on unbounded transcript copying;
- silently discard historical state;
- couple the solution only to the single observed rollout path.

---

## Suggested investigation sequence

1. **Establish the current lifecycle precisely.** Trace `thread.turn.start` from orchestration dispatch through `ProviderCommandReactor.ensureSessionForThread()`, `ProviderService.startSession()`, the Codex adapter, and `CodexSessionRuntime`.
2. **Audit all recovery entry points.** Distinguish normal start, stale-session recovery, creation recovery, runtime-mode restart, model change, process restart, and explicit `recoveryPolicy: "forbid"`.
3. **Audit persistence.** Inspect provider binding schema, migration history, update semantics, and whether one shuv thread can safely retain retired provider-generation metadata.
4. **Audit transcript authority.** Determine what current projections can reconstruct and what provider-native context would be lost.
5. **Re-run commit archaeology.** Confirm the five-commit causal chain and inspect surrounding tests and plans.
6. **Prototype health detection without mutation.** Determine whether rollout size and/or resume time can be bounded safely.
7. **Design replacement as a transaction/state machine.** Include failure and crash recovery paths.
8. **Write tests first.** Cover rollover under the same thread, bounded handoff, atomic rebinding, retries, model/runtime-mode preservation, and timeout behavior.
9. **Only then implement.** Do not combine this core lifecycle change with desktop shell rendering in one uncontrolled patch.

---

## Likely relevant files

Core provider lifecycle:

```text
apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
apps/server/src/provider/Layers/ProviderService.ts
apps/server/src/provider/Layers/ProviderService.test.ts
apps/server/src/provider/Layers/CodexAdapter.ts
apps/server/src/provider/Layers/CodexSessionRuntime.ts
apps/server/src/provider/Layers/CodexSessionRuntime.test.ts
apps/server/src/provider/Layers/ProviderSessionDirectory.ts
apps/server/src/provider/Services/ProviderAdapter.ts
apps/server/src/provider/Services/ProviderService.ts
apps/server/src/provider/Services/ProviderSessionDirectory.ts
apps/server/src/provider/Drivers/CodexDriver.ts
apps/server/src/provider/Drivers/CodexHomeLayout.ts
```

Orchestration contracts and projections:

```text
packages/contracts/src/orchestration.ts
packages/contracts/src/provider.ts
apps/server/src/orchestration/decider.ts
apps/server/src/orchestration/projector.ts
apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
```

Existing bounded bootstrap artifact:

```text
apps/web/src/historyBootstrap.ts
apps/web/src/historyBootstrap.test.ts
```

Desktop startup, separate track:

```text
apps/desktop/src/app/DesktopApp.ts
apps/desktop/src/backend/DesktopLocalServerAttach.ts
apps/desktop/src/backend/DesktopLocalServerAttach.test.ts
apps/desktop/src/window/DesktopWindow.ts
```

Product/context documentation:

```text
AGENTS.md
PRODUCT.md
HANDOFF.md
docs/internals/providers.md
docs/internals/glossary.md
```

---

## Verification commands

Clone the remote repository if no checkout has been provided:

```bash
git clone https://github.com/shuv1337/shuv2code.git
cd shuv2code
```

The investigation observed revision `031b7464289cebd05a973d7244767cf982566710`. Use a separate worktree if you need to inspect that exact baseline without disturbing newer work:

```bash
git fetch origin
git worktree add ../shuv2code-incident-baseline \
  031b7464289cebd05a973d7244767cf982566710
cd ../shuv2code-incident-baseline
```

Inspect dirty state before doing anything:

```bash
git status --short
```

Inspect commit summaries:

```bash
git log --no-walk --date=short \
  --format='%h  %ad  %an  %s' \
  57f5b836 36802d70 bb8a8444 77716b4c 3b98fe35
```

Inspect relevant diffs:

```bash
git show 57f5b836 -- \
  apps/renderer/src/components/ChatView.tsx \
  apps/renderer/src/historyBootstrap.ts

git show 36802d70 -- apps/web/src/components/ChatView.tsx

git show bb8a8444 -- \
  apps/server/src/provider/Layers/ProviderService.ts \
  apps/server/src/codexAppServerManager.ts

git show 77716b4c -- \
  apps/server/src/provider/Layers/ProviderService.ts

git show 3b98fe35 -- \
  apps/server/src/provider/Layers/CodexSessionRuntime.ts
```

Confirm no bootstrap production caller:

```bash
rg -n 'buildBootstrapInput' apps/web/src \
  --glob '!historyBootstrap.ts' \
  --glob '!historyBootstrap.test.ts'
```

Inspect current cursor selection and Codex resume:

```bash
rg -n -C 8 \
  'effectiveResumeCursor|persistedBinding|thread/resume|readResumeCursorThreadId' \
  apps/server/src/provider/Layers/ProviderService.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.ts
```

The 880 MB rollout, 2 GB SQLite database, Chromium profile, and user Codex configuration are source-machine evidence, not repository fixtures. A remote agent cannot verify their sizes from GitHub. If the user later provides a mounted evidence bundle, inspect it read-only and record checksums before analysis.

---

## Expected output from the next agent

Before implementation, return:

1. A corrected end-to-end sequence diagram for current session start/resume.
2. A fact-checked causal account of the five commits, including any corrections to this dossier.
3. A provider-neutral rollover state machine with Codex-specific detection hooks.
4. A bounded continuity packet design and source-of-truth analysis.
5. Failure, crash, concurrency, and rollback semantics.
6. A migration assessment for provider bindings and retired generations.
7. A focused test plan with exact files and cases.
8. A phased implementation plan that keeps desktop shell work separate.
9. Explicit risks and unresolved product decisions requiring user approval.

Do not begin by deleting state, replacing the user-visible thread, or adding an arbitrary timeout without a continuity and recovery design.

---

## Final plain-language statement

shuv2code remembers which hidden Codex conversation belongs to each visible conversation. It currently keeps reopening that same hidden conversation forever. One hidden conversation grew to 880 MB, and Codex took about three and a half minutes to reopen it. shuv2code already has the visible history, but the old mechanism for giving a fresh Codex conversation a limited copy of that history was removed during an orchestration rewrite. Later changes made reopening the old Codex conversation automatic.

The fix is not to throw away the user's shuv2code thread. The fix is to let shuv2code replace an unhealthy hidden provider conversation, hand the replacement enough bounded context to continue, and keep the same visible thread intact.
