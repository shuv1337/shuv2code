# ADE V1 Implementation Spec

Assembled 2026-08-23 from wayfinder map [#129](https://github.com/shuv1337/shuv2code/issues/129)
(final ticket [#140](https://github.com/shuv1337/shuv2code/issues/140)). Decision authority remains
[ADE-FORK-DECISION.md](https://github.com/shuv1337/psychoharness/blob/main/ADE-FORK-DECISION.md) (the ADR);
this spec is authoritative on implementation **shapes** — schemas, services, APIs, UI slices, build sequence,
verification. On conflict about *why* or *whether*: the ADR wins. On conflict about *how*: this spec wins.

Per-decision detail lives in the closed map tickets; each section links its source. Vocabulary is defined in
[/CONTEXT.md](../../CONTEXT.md).

---

## 1. System overview

- **Two bounded execution kernels** (ADR §2.2): **shuvcode** (attach-only to the operator's
  `shuvcode service start` background service; primary kernel for all text work) and **Codex**
  (shared supervised app-server process; coordinator specialized sessions + all voice).
- **ADE is additive** (ADR §17.2): the existing coding-tool UX (sessions/chat, terminal, review, source
  control, previews, automations, mobile) keeps working. ADE is a new captain-facing surface and Electron
  target sharing server, contracts, client-runtime, auth, and desktop infrastructure.
- **Trusted-host V1** (ADR §9): single operator, no hostile isolation. Possession/structure = attribution.
- **Fresh database** (ADR §17.3): ADE durable state starts empty; no alpha-data migration.
- **Ownership boundary** (ADR §19): ADE owns organization/authority state (bots, assignments, projects,
  publication, provisioning, Needs You); shuvcode owns execution state (sessions, inbox semantics, messages,
  logs). ADE binds to kernel state, never mirrors it.

## 2. Domain schemas

Source: [#136](https://github.com/shuv1337/shuv2code/issues/136) (frozen outline). Field-level Effect/Schema
code lands in `packages/contracts` (schema-only package) as build work; names and relationships below are frozen.

### 2.1 Identity & bots

- Branded ids: `BotId`, `ProjectId`, `AssignmentId`, `PersonaVersionId`, `PublicationStackId`, `IntegrationCandidateId`, `NeedsYouItemId`, …
- **`Bot`**: id, name, display meta, structural role `firstmate | second-mate | crew | workspace-specialist`,
  free-form `roleTag` ("Coder", "Reviewer", "Researcher"), optional `projectId`, `activePersonaVersionId`,
  Screenbox provisioning ref, `computerUse: boolean` (default false), created/archived timestamps.
  The Firstmate bot is permanent — rename/persona edits allowed, archive/delete forbidden.
- **`PersonaVersion`**: id, botId, content, createdAt, activatedAt. Edits take effect at next session (ADR §12.1).
- **`MemoryDocument`**: botId (1:1), bounded content, updatedAt, updatedBy `bot | captain`. Tool-mediated
  writes only (ADR §12.2).
- **`BotExecutionBinding`**: botId, engine `shuvcode | codex`, kernel sessionId, purpose
  `primary-text | parallel-work | voice | specialized-work`, status `active | historical | lost`, timestamps.

### 2.2 Assignments (ADR §13)

- **`Assignment`**: id, idempotencyKey, requester (`botId | captain`), recipient botId, optional projectId,
  instruction, declaredRisk, parentAssignmentId (lineage), status
  `queued | running | blocked | completed | failed | cancelled`,
  `blockedReason?: approval | children | needs-resume | kernel-down`, queue position (FIFO + explicit reorder),
  result `{ status, summary ≤16KB, artifacts: ArtifactRef[] }`, delivery record `{ delivered, deliveredAt }`
  (exactly-once at product level), timestamps.
- **`ArtifactRef`** (closed union): `jjChange {changeId, projectId} | publicationLayer {stackId, layerId} | file {path} | url {href}`.
- Semantics (all ADR §13, locked): idempotent creation; per-bot FIFO with explicit reorder, no priority
  scheduler; no auto-retry, no auto-timeout — stall surfacing instead; steer ≠ cancel, explicit cascade-cancel;
  batched child notifications with explicit parental waits; structured completions delivered as synthetic input.

### 2.3 Projects & integration (ADR §6, §7, §14)

- **`Project`**: id, name, secondMateBotId, optional `repoBinding {path, remote}` (JJ required iff bound),
  integration policy default, check commands, `sharedSpecialistAllowList: BotId[] | "all"`, optional limits overrides.
- **`IntegrationCandidate`**: id, projectId, source assignment(s), changeIds, status
  `queued | running | awaiting-review | awaiting-approval | integrated | bounced`. One running candidate per
  project; restart re-runs the queue head (ADR §16.2) — no per-step journal.
- Grants = structural role rules + `Project.sharedSpecialistAllowList`. No policy language, no capability matrix.

### 2.4 Publication (ADR §8 + spike [#134](https://github.com/shuv1337/shuv2code/issues/134))

- **`PublicationStack`**: id, projectId, mode `native-stack | chained`, status
  `building | review-frozen | merging | merged | reconciled`, stack URL, optional native stack number/node_id
  (presentation only, per ADR §8.3).
- **`PublicationLayer`**: id, stackId, order, changeIds, bookmark name, **mutable `prNumber`** (+ adopt-by-head-branch
  fallback), `headSha`, `submittedSha`, `mergeSha`, re-read `prState`, base computed each pass, status.
  `changeId` is invalid once merged — post-merge logic keys on recorded SHAs.

### 2.5 Screenbox, Needs You, limits

- **`ScreenboxProvisioning`**: botId (idempotency key), status, containerRef, volumeRef, createdAt, lastNeededAt.
- **`NeedsYouItem`**: id, kind `approval | kernel-down | stall | provision-failure | form`, subject refs, status,
  timestamps. One durable item; multiple renderings (§7).
- **`LimitsConfig`**: singleton captain-tunable settings carrying the ADR §18.1 defaults; seeded at first boot.

## 3. Kernel adapters & the tool plane

Sources: [#135](https://github.com/shuv1337/shuv2code/issues/135) (+ amendment),
[#136](https://github.com/shuv1337/shuv2code/issues/136), [#130](https://github.com/shuv1337/shuv2code/issues/130),
[#131](https://github.com/shuv1337/shuv2code/issues/131).

### 3.1 Session-scoped dynamic tools (primary)

- **Codex**: `dynamicTools` on `thread/start` (experimental API accepted; persisted in rollout, restored on resume).
- **shuvcode**: an equivalent **session-scoped dynamic-tool extension lands upstream**
  ([Latitudes-Dev/shuvcode](https://github.com/Latitudes-Dev/shuvcode)); the ADE adapter consumes it.
  The interim location-scoped MCP re-injection path from #135 is **not built** — the extension is sequenced
  early enough to precede the gate (§9).
- **Attribution is structural**: invocations arrive on the session-owning connection → session-level
  attribution everywhere, no credential needed. ADE's registry maps connection/session → {bot, binding}.
- **Fallback** (kept specified, not built unless a blocker emerges): injected MCP config + ADE-minted bearer
  credentials (#135 original design).

### 3.2 The controller gate

- ADE registers each bot's tool catalog at session start; a single dispatch layer resolves
  {bot, session} and runs **inline plain-code checks** (routing target allowed, assignment ownership,
  Screenbox eligibility). No policy engine, no scopes inside bot-facing anything.
- **Approvals are structurally absent from the tool plane**: captain approvals exist only on the client
  surface (WS + `ade:approve` scope, ADR §10.4). No bot-reachable surface can name them.
- Turn-level correlation: deferred (buys nothing under trusted-host).

### 3.3 Codex kernel adapter

Shared supervised app-server (ADR §10.2); realtime voice coexists by design (#131 — thread-scoped
notifications, WebRTC media off the control socket; restart-only enablement changes, shared crash blast radius accepted).
Affordances the adapter binds: `thread/inject_items` (assignment results / notifications), `turn/steer` /
`turn/interrupt` (steer-vs-cancel), `thread/status/changed` + `item/permissions/requestApproval` +
`mcpServer/elicitation/request` (Needs You surfacing), `thread/fork` + parent/ancestor filters (binding
bookkeeping), `serviceName` + `clientInfo` (tagging), `--ws-auth` on listeners.

### 3.4 shuvcode kernel adapter

Attach-only (never spawns). Binds: `POST /:id/synthetic` (result delivery; queue-vs-steer explicit),
session create/fork/list for binding bookkeeping, interrupts/waits. Upstream punch list beyond dynamic tools:
session ownership metadata (desirable), `_meta` invocation proof (deferred hardening).

## 4. Services

### 4.1 Bootstrap & bot lifecycle ([#141](https://github.com/shuv1337/shuv2code/issues/141))

- **Ensure-on-boot Firstmate**: idempotent boot check creates the Firstmate (shipped persona → `PersonaVersion`
  v1, empty memory) iff no firstmate-role bot exists. Self-healing; no first-boot flag.
- **No wizard**: empty-state CTA → standard project-create form. Project creation auto-creates its Second Mate
  from the shipped template. Researcher/Coder/Reviewer ship as one-click copy-on-create templates
  (instantiation copies content into `PersonaVersion` v1; template link ends there).
- **No kernel gate**: app fully navigable while degraded; health pills + welcome-copy hint only.
- **Canned welcome, lazy session**: static first-run copy; first kernel session starts on the captain's first message.
- First boot writes `LimitsConfig` with ADR §18.1 defaults.

### 4.2 Assignment engine (ADR §13, §16.1)

Owns Assignment records, per-bot FIFO queues, lineage, blocked states, result capture, and **exactly-once
delivery** of structured completions as synthetic input (shuvcode `synthetic`, Codex `inject_items`).
Recovery: re-adopt running work where the binding survives, else mark `blocked: needs-resume` (never silent restart).

### 4.3 Session & rollover service (ADR §12)

Projects persona + memory + active assignments + outgoing-session summary into new sessions; maintains
`BotExecutionBinding` records; enforces one active primary text session per bot.

### 4.4 Integration service (ADR §6.2, §7, §16.2)

Serialized per project: one candidate at a time through
`queued → running → awaiting-review → awaiting-approval → integrated | bounced`. Explicit upstream sync;
isolated JJ workspaces; declared-risk-only gate classification; designated Reviewer with Second Mate fallback,
never self-review; always-green per-project checks; repair assignments to the originating bot. Restart: re-run
the queue head.

### 4.5 Publication service (ADR §8, spike #134 — binding constraints)

Native GitHub Stacked PRs (`gh stack link` / `gh stack merge`) primary; chained PRs fallback (identical jj-side
mechanics). **Invariants**:
1. every pass begins `jj git fetch` + fresh `gh` reads (converge-then-act); durable `changeId` recreates lost bookmarks;
2. `prNumber` is mutable — replacement PRs must be representable;
3. post-merge reconciliation keys on recorded SHAs, never change IDs (`jj rebase --skip-emptied` for refresh);
4. the service **never writes files inside operated workspaces**; `@` positioned deliberately;
5. never `--delete-branch`; cleanup is the explicit post-reconcile pass.
Recovery: GitHub-reconciling (re-read PR/stack state, converge).

### 4.6 Screenbox integration ([#139](https://github.com/shuv1337/shuv2code/issues/139))

- **Upstream unmodified**, operator-run, loopback; internal policy off (`idle_pause_minutes=0`,
  `auto_snapshot_minutes=0`, leases unused). ADE is upstream's only client, via HTTP API + SSE `/api/events`.
- **ADE-proxied dynamic tools**: operate-only subset (`desktop_screenshot/look/click/type/key/shell/batch`,
  `desktop_chrome/window/file`, help) rides the dynamic-tool surface; ADE forwards invocations holding the
  single admin token; `desktop_id = botId`; no Screenbox credential ever enters session config. Schemas fetched
  from upstream `tools/list` at boot, filtered, cached last-good.
- **Provisioning**: first tool call provisions synchronously against the durable botId-keyed record; failure →
  Needs You `provision-failure`; per-bot `computerUse` toggle (default off); at the 4-desktop cap refuse with a
  clear error naming occupants.
- **Idle-stop**: ADE tracks last tool-forward + viewer presence; after the `LimitsConfig` idle window, upstream
  `stop`. Transparent restart-on-need before the next forward. Boot reconciles provisioning records against
  upstream's desktop list.
- **Viewer**: ADE server terminates WS→VNC proxy per desktop (captain-session auth), serving vendored noVNC;
  upstream dashboard never exposed. Screen tab carries explicit Start/Stop; viewing never spawns.
- **Delete**: confirm-gated bot delete → `destroy(save_snapshot=false)` + `delete-data` + snapshot purge.
  No snapshot feature in V1.

### 4.7 Voice service ([#138](https://github.com/shuv1337/shuv2code/issues/138), ADR §15)

- **Per-bot voice binding** (`purpose: "voice"`); existing controller/transport pair machinery instantiated per
  bot; controller actions carry that bot's authority — no impersonation layer. Firstmate voice = the Firstmate's binding.
- **Toolkit** (shared catalog with text-side dynamic tools): `fleet_read`, `steer_primary`, `create_assignment`,
  `update_memory`, approval tools (captain channel only).
- **Two-phase verbal approvals**: `prepare_approval(needsYouId)` → restatement + short-lived confirmation token →
  spoken confirmation → `commit_approval(needsYouId, token)`. Commit without live token fails closed; rides the
  VoiceAction fence.
- **In**: `initialItems` = persona projection + memory + active assignments + bounded recent-messages window.
  **Out**: end-of-call bounded summary delivered to the primary session as **queued** synthetic input (never
  steer) + optional `update_memory`. Recovery: drop-and-redial.

### 4.8 Health checker

Monitors shuvcode service, Codex supervisor, Screenbox runtime → sidebar pills; kernel-down also lands as a
Needs You item and flips affected assignments to `blocked: kernel-down` (queue-and-alert, no failover, ADR §11.3).

## 5. APIs & transport

Wholesale reuse of existing WS transport + auth (ADR §10.4); relay/tailnet remote access unchanged. New:
the **`ade:approve` scope** (captain approval surface), ADE WS message families for fleet/assignment/Needs You
state, and the Screenbox viewer WS proxy route. Contracts live in `packages/contracts`; client state in
`packages/client-runtime` for web + Electron ADE target.

## 6. Persistence

New ADE-owned tables (fresh DB) for every §2 entity. shuvcode execution state is consumed via its API, never
copied. Codex sits behind the thinner normalization/binding layer (ADR §19.2).

## 7. UI slices ([#137](https://github.com/shuv1337/shuv2code/issues/137))

Home = **Firstmate conversation**; persistent **fleet sidebar** (projects/crews tree, running assignments,
Needs You badge, kernel pills). All eight surfaces ship thin:
1. **Firstmate/bot chat** — existing conversation component stack over client-runtime, scoped to the active
   binding, ADE chrome (persona header, assignment context); new rendering only for assignment-result synthetic items.
2. **Roster + bot detail** — bots, roles, bindings, captain-editable memory, persona versions, computer-use toggle.
3. **Project view** — three stacked panels: crew, integration queue, publication stack.
4. **Work graph** — filterable list + tree of assignment lineage; no canvas.
5. **Needs You** — inbox (badge → list → detail, approve/deny) + the same items inline in context. `ade:approve` required.
6. **Screen viewer** — Screen tab embedding noVNC via the ADE proxy; "not started" state; Start/Stop actions.
7. **Voice entry** — main-surface button (Firstmate) + per-bot entry, reusing existing voice UX.
8. **Kernel/fleet health** — sidebar pills backed by the health checker.

## 8. Out of scope (V1)

Needs You push notifications (post-V1, relay/APNs); budgets (struck, ADR §18.2); multi-host/runner topology,
hostile isolation, mobile voice; snapshots; consolidation of the coding UX into ADE.

---

## 9. Build sequence

Tracked as epic **“ADE V1 build”** with GitHub sub-issues, native blocked-by dependencies, label `ade:build`.
Upstream shuvcode work is filed on Latitudes-Dev/shuvcode and bridged by S4. Sizing: one focused agent session
each. `←` lists blockers.

**Phase 0 — strip (ADR §17.1)**
- **S1. Provider strip stack** — remove OpenCode v1, Grok, Cursor, Claude drivers/adapters/providers +
  their settings, usage-scanner, composer, and startup-default seams; keep Codex + OpenCodeV2 (shuvcode);
  tree boots green at every layer of one short stacked series.

**Phase 1 — foundation**
- **S2. ADE contracts + persistence** ← S1 — `packages/contracts` schemas for §2, DB tables/migrations on the fresh database.
- **S3. Bootstrap: ensure-Firstmate + templates + LimitsConfig** ← S2 — §4.1 seed content and boot service.
- **S4. shuvcode dynamic-tool extension (bridge)** — upstream session-scoped dynamic tools land in
  Latitudes-Dev/shuvcode (+ session ownership metadata if cheap); shuv2code adapter consumes them. Unblocked
  from day one; runs parallel to S1–S3.
- **S5. Codex kernel adapter** ← S2 — supervisor client binding §3.3 affordances.
- **S17. Health checker + pills** ← S3 — §4.8 (early: everything else surfaces through it).

**Phase 2 — gate & core**
- **S6. ADE tool gate** ← S2, S4, S5 — dynamic-tool registry, dispatch, inline checks, structural attribution (§3.1–3.2).
- **S7. Assignment engine** ← S6 — §4.2 + §2.2 semantics end-to-end on both kernels.
- **S8. Persona/memory/rollover services** ← S3, S5 — §4.3 + persona projection + memory tools.
- **S9. Captain skeleton: Firstmate chat + sidebar + roster** ← S6, S7, S8 — UI slices 1, 2, 8 thin.
  **Milestone: walking skeleton** — talk to Firstmate, delegate one assignment, see its structured result delivered.

**Phase 3 — critical path to publish**
- **S10. Integration service** ← S7 — §4.4.
- **S11. Publication service** ← S10 — §4.5 invariants + reconciliation.
- **S12. Project view + work graph UI** ← S9, S10 — UI slices 3, 4 (publication panel lands with S11).
- **S13. Needs You inbox + `ade:approve`** ← S9 — UI slice 5 + approval scope end-to-end.

**Phase 4 — parallel tracks (post-skeleton)**
- **S14. Screenbox proxy + provisioning + idle policy** ← S6 — §4.6 tool plane, provisioning, idle-stop, boot reconcile.
- **S15. Screenbox viewer + Screen tab + delete** ← S14, S9 — WS→VNC proxy, noVNC embed, Start/Stop, delete purge.
- **S16. Voice retargeting** ← S6, S9 — §4.7 bindings, toolkit, two-phase approvals, digest/summary.

**Phase 5 — acceptance**
- **S18. V1 acceptance walkthrough** ← all — §10.2 scenarios run once against a fresh boot; close = V1 done.

## 10. Verification

### 10.1 Per-issue

Every build issue carries a verification checklist: focused tests for changed behavior (`vp test run …`),
targeted lint/type checks, and — for user-visible frontend work — one integrated pass per affected client
surface (test-shuv2code-app / -mobile skills). Repo-wide suites stay off the routine path (AGENTS.md).
Invariant-heavy services (S7 exactly-once/idempotency, S11 converge-then-act/reconciliation, S14 idle/restart)
must encode their invariants as tests inside their own issue, not defer them to S18.

### 10.2 V1 acceptance walkthrough (S18)

Captain-visible, run once against a fresh database with all three runtimes up:
1. **First boot** — Firstmate exists (ensure-on-boot), welcome copy + kernel hint, LimitsConfig seeded, pills green.
2. **First project** — empty-state CTA → create project with repo binding → Second Mate auto-created; add a
   Coder from template.
3. **Assign & observe** — captain asks Firstmate; a delegated assignment reaches the Coder (FIFO, lineage in
   work graph); structured completion returns as synthetic input, exactly once.
4. **Integrate & publish** — candidate flows queued→integrated under review policy; stack publishes via
   `gh stack link`; whole-stack merge reconciles; workspaces clean; no orphaned branches.
5. **Needs You** — an approval lands in the inbox and inline; approve with `ade:approve`; deny path too.
6. **Screenbox** — enable computer-use on a bot; first tool call provisions; Screen tab views; idle-stop then
   transparent restart; cap refusal message; bot delete purges.
7. **Voice** — per-bot call carries persona/memory/assignments in; two-phase verbal approval round-trips;
   end-call summary arrives queued in the primary session.
8. **Degraded** — stop shuvcode service: pills flip, assignments block `kernel-down`, app stays navigable;
   restart: re-adopt/blocked recovery per ADR §16.
