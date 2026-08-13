# PLAN-103: OpenCode v2 provider (`opencode2`) and ask-questions forms

Issue: [#103](../../issues/103) · bug · size:M (work is larger; the label understates the split)
Status: investigation, plan review, and option grilling complete. Ready to
implement after the user confirms shared understanding. No product
implementation has been done.

## Goal

Ship a first-class **OpenCode v2** provider that speaks the live v2 protocol natively
(not a rewrite into the v1 SDK shape). When that provider’s session invokes ask-questions,
shuv2code shows the structured prompt, the thread waits on input, answers reach the owning
session, and the turn resumes. Refresh / navigation must not hide an unresolved prompt.

Existing **OpenCode v1** stays its own provider. Binary path and display name remain
overridable in provider settings; the new driver’s default display name is **`opencode2`**.

## Root cause (confirmed, then reframed)

### What the first investigation got right

The live incident thread
(`~/.shuv2code/userdata/logs/provider/events.42276398-….log`) never observed a
`question.asked` event. The `question` tool started at 19:54:18, streamed input until 19:54:24,
then sat silent until the user answered in the TUI at 20:03.

The `question` tool (`/home/shuv/repos/shuvcode/packages/core/src/tool/plugin/question.ts`)
calls **`forms.ask`**, which publishes `form.created` / `form.replied` / `form.cancelled`.
`sessionID` is nested inside `form`. `OpenCodeAdapter.openCodeEventSessionId` only reads
`properties.sessionID` / `properties.info.id`, so `form.created` is dropped **before** the
native-event log write.

Downstream (ingestion → projection → web `derivePendingUserInputs`) is healthy. Codex and
Claude already use it.

### What the first investigation got wrong

`form.*` is **upstream OpenCode v2**, not a shuvcode fork invention:

- `780c99bc2e` `refactor(core): route questions through forms (#35422)` — Aiden Cline,
  2026-07-05, on `upstream/v2` and `upstream/beta`.
- shuvcode only absorbed it via `1c47c7b9f3` `chore: merge upstream v2 (283258e95b0a)`.
- The question tool no longer publishes `question.asked`. Live ask-questions traffic is
  `form.*`. Upstream TUI / ACP / noninteractive CLI already consume `form.*` and read
  `event.data.form.sessionID`.

### Why a compat-layer translation is the wrong fix

Today `createOpenCodeSdkClient` (`apps/server/src/provider/opencodeRuntime.ts:802`) does:

```
protocol === "v2"  →  createOpenCodeV2CompatibilityClient   // hand-rolled HTTP + event rewrite
protocol === "v1"  →  createOpencodeClient from @opencode-ai/sdk/v2
```

1. Published `@opencode-ai/sdk@1.15.13` `/v2` is still the **old** protocol (`question.asked`,
   `callID`, no `form.*`).
2. `opencodeV2Compatibility.ts` smashes live v2 SSE/HTTP back into that old shape so one
   adapter can serve both generations. That is why `session.tool.*` `id` vs `callID` already
   silently fails, and why `form.created` never reaches the adapter.

v1 and v2 differ in event envelope (`properties` vs `data`), session lifecycle
(`session.status` vs `session.execution.*`), tool identity (`callID` vs `id`), pending-input
surface (`question.*` vs `form.*`), process model (per-session spawn vs shared background
service), and HTTP routes. They should not share an adapter.

## Decision and rationale

**Split into two drivers. The new driver is a broad OpenCode v2 provider, not a form-only
shim.**

- New driver kind: `opencodeV2`. Default instance id: `opencodeV2`. Default display name:
  **`opencode2`**. Users can override binary and display name in provider settings (already
  supported). Do not special-case “shuvcode” in the default label.
- Existing driver kind `opencode` stays **v1-only**. Delete the v2 branch from
  `createOpenCodeSdkClient`. Refuse to attach a v2 binary or v2 server.
- The v2 driver owns a typed HTTP + SSE client against the **live** OpenAPI
  (`/home/shuv/repos/shuvcode/packages/protocol/openapi.json`), not `@opencode-ai/sdk/v2`.
- Map live v2 events **directly** to shuv2code `ProviderRuntimeEvent`s. Do not invent
  `question.asked` / `message.part.*` / `session.status` / `session.updated` intermediates.
- A `ProviderInstance` is adapter + snapshot + text generation. The v2 driver must own all
  three natively. Do not delete `opencodeV2Compatibility.ts` until adapter, inventory/probe,
  and text-generation production callers are gone.

Reference for the live event catalog (do not import from `.repos/` or the shuvcode tree):
`/home/shuv/repos/shuvcode/packages/tui/src/mini/stream-v2.transport.ts` and
`packages/schema/src/session-event.ts`.

## Confirmed plan-review corrections

These replace earlier assumptions in this document. They were validated against the current
repo and the live shuvcode v2 protocol on 2026-08-13.

### Forms and web

1. **Question IDs are field keys, not the form id.** Web drafts and replies are keyed by
   `UserInputQuestion.id` (`apps/web/src/pendingUserInput.ts:105-113`). The question tool
   writes answers as `state.answer[qN]` (`/home/shuv/repos/shuvcode/packages/core/src/tool/plugin/question.ts:96-127`).
   `requestId` is `form.id`; each question `id` is `field.key`.
2. **Generic form contracts cannot represent live forms.** Live fields include string,
   number, integer, boolean, multiselect, and external, plus `when`, `required`, defaults,
   validation, and `custom` (`/home/shuv/repos/shuvcode/packages/schema/src/form.ts:39-114`).
   `UserInputQuestion` is only header/question/options/multiSelect
   (`packages/contracts/src/providerRuntime.ts:486-501`). Surfacing every session-owned form
   without a contract/UI expansion is not implementable in this issue.
3. **Option replies must use protocol values, not labels.** Live options have distinct
   `value` and `label` (`/home/shuv/repos/shuvcode/packages/schema/src/form.ts:18-22`). The
   question tool happens to set them equal. If this issue stays question-only, labels may be
   submitted. If generic forms stay in scope, the adapter must translate labels back to
   values.
4. **Zero-option custom-only questions are dropped today.** `parseUserInputQuestions`
   returns `null` when `options.length === 0` (`apps/web/src/session-logic.ts:448-450`). M3
   must keep them and add parser, helper, and UI-path tests.
5. **Field titles/descriptions can be empty.** Runtime `header`/`question` require
   non-empty strings. Fall back to `field.key` or `form.title`.
6. **Successful form POST can race the ephemeral resolve event.** `form.replied` is
   published before the HTTP reply completes (`/home/shuv/repos/shuvcode/packages/core/src/form.ts:178-193`)
   and is ephemeral. After a successful `POST .../form/:id/reply`, synthesize
   `user-input.resolved` (or reconcile via form state/list) and dedupe against SSE.

### Binding, routing, and lifecycle

7. **Continuation grouping cannot migrate `opencode` → `opencodeV2`.** Recovery routes by
   exact `providerInstanceId` (`apps/server/src/provider/Layers/ProviderService.ts:482-538`).
   Orchestration rejects a driver-kind change before comparing continuation keys
   (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:712-733`).
   `ProviderSessionDirectory` stores driver + instance, not a continuation key
   (`apps/server/src/provider/Services/ProviderSessionDirectory.ts:17-31`).
8. **A cursor-only remap is insufficient.** Idle threads fall back to
   `thread.modelSelection.instanceId` (`ProviderCommandReactor.ts:639-646`). Projected
   sessions persist their own `providerName` / `providerInstanceId`
   (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1219-1224`).
9. **Durable detach / cursor settlement / startup recovery are hard-coded to `opencode`**
   (`ProviderService.ts:391-421`, `1658-1695`, `1703-1753`). A new driver kind would lose
   restart adoption unless those paths become capability-based
   (`hasDurableSessionRecovery` already exists on the adapter contract).
10. **There is no post-hydration mutation hook.** Hydration is pure map derivation plus
    reconcile (`ProviderInstanceRegistryHydration.ts:73-173`). Binding needs a separate
    service/layer that probes, serializes writes, and defines persisted vs ephemeral
    instances.
11. **Legacy `providers.opencode` has no environment/display/accent.** Those live on
    `ProviderInstanceConfig` (`packages/contracts/src/providerInstance.ts:124-131`). Copy
    the whole envelope only from an explicit `providerInstances.opencode` entry.
12. **Probe must cover configured servers, not only binary version.** `serverUrl` already
    uses `/api/health` (`opencodeV2Service.ts:345-392`). A v1 binary can point at a v2
    server and the reverse.
13. **Fail-closed must be in connect/adapter/inventory/text-generation, not only snapshot
    status.** `OpenCodeAdapter.startSession` currently accepts whatever protocol
    `connectToOpenCodeServer` returns (`OpenCodeAdapter.ts:1466-1476`).
14. **Shared-service discovery can attach distinct instances to one process**
    (`opencodeV2Service.ts:297-342`). `supportsMultipleInstances: true` is not free.
15. **New resume cursors need a protocol discriminator.** `{ schemaVersion: 1, sessionId }`
    is not enough (`OpenCodeAdapter.ts:64-120`). Use something like
    `{ kind: "opencode-v2", schemaVersion: 1, sessionId, activeTurnId }`.

### Native v2 mapping

16. **There is no v2 abort route.** Interrupt is
    `POST /api/session/:sessionID/interrupt`
    (`/home/shuv/repos/shuvcode/packages/protocol/src/groups/session.ts:649-661`).
17. **`session.updated` is v1-only.** Native v2 title changes are `session.renamed`
    (`/home/shuv/repos/shuvcode/packages/schema/src/session-event.ts:101-109`).
18. **Execution events have no turn id.** Persist/restore `activeTurnId` in the resume
    cursor. Missing or colliding turn ids are rejected by the ingestion guard
    (`ProviderRuntimeIngestion.ts:1322-1360`).
19. **Text fragments are `(assistantMessageID, ordinal)`.** Emit `item.started` on
    `session.text.started`, use a stable item id from both fields, and reconcile
    `session.text.ended.text` against already-emitted deltas
    (`session-event.ts:336-371`; TUI `stream-v2.transport.ts:1103-1137`).
    Convert live `created` milliseconds to ISO `createdAt`.
20. **Later tool events omit the tool name.** Only `session.tool.input.started` has
    `name` (`session-event.ts:444-535`). Keep a local id → name map and recover from
    projected messages on adopt.
21. **SSE is volatile.** Subscribe first, require `server.connected`, buffer while
    hydrating forms **and** permissions, then replay
    (`stream-v2.transport.ts:851-891`, `1404-1433`).
    `GET /api/session/:sid/permission` is required on start/adopt, not just forms.
22. **SSE envelopes are richer than `{id,type,created,data}`.** Durable events also carry
    `durable`, and may carry `location` / `metadata` (`packages/schema/src/event.ts:60-71`).
23. **Session/form HTTP responses unwrap `{ data: ... }`.** Fork requires a `boundary`
    payload. Permission reply body is `{ reply: "once"|"always"|"reject", message? }`.

### Driver completeness and surfaces

24. **`ProviderInstance` requires snapshot and text generation**, not only an adapter
    (`ProviderDriver.ts:64-74`). Existing inventory and text generation still call
    `createOpenCodeSdkClient` (`OpenCodeProvider.ts:402-428`,
    `OpenCodeTextGeneration.ts:395-417`, `opencodeRuntime.ts:802-816`).
25. **Settings need the full trio:** `OpenCodeV2Settings`, `OpenCodeV2SettingsPatch`, and
    `ServerSettingsPatch.providers.opencodeV2` (`settings.ts:555-561`, `656-662`,
    `714-722`).
26. **Web registries are hard-coded separately:** `providerDriverMeta.ts`,
    `session-logic.ts` `PROVIDER_OPTIONS`, `composerDraftStore.ts` provider keys,
    `ProviderModelsSection.tsx`, `providerIconUtils.ts`, `contextWindow.ts`,
    `PROVIDER_DISPLAY_NAMES`, `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`.
27. **Maintenance identity is keyed by driver kind.** Do not reuse
    `OPENCODE_MAINTENANCE_DEFINITION` unchanged (`OpenCodeDriver.ts:62-69`).
28. **M4 cannot rely on a live model to produce an exact tool/form sequence.** Add a
    deterministic mock v2 service before browser verification.

## In scope

Broad v2 compatibility in the new driver — enough that a normal shuvcode / upstream-v2
session is usable in shuv2code, plus the issue-103 form flow:

**Client / process**

- Attach to the existing shared v2 background service (`opencodeV2Service.ts`). Do not spawn
  a private v2 serve.
- Session create / get / fork / prompt / **interrupt** / wait / active.
- SSE `/api/event`: subscribe first, require `server.connected`, buffer during hydration.
  Decode live envelopes including `durable` / `location` / `metadata`. Keep buffer limits.

**Session filter**

- Resolve session id from `data.sessionID`, then `data.form?.sessionID`, then `data.info?.id`.
- Ignore `sessionID === "global"` forms.

**Turn / text / reasoning**

- Persist a local `activeTurnId` in the v2 resume cursor and restore it on adopt.
- `session.execution.started` → `turn.started` with that turn id + session running.
- `session.execution.succeeded` → `turn.completed { state: "completed" }`.
- `session.execution.failed` → `turn.completed { state: "failed", errorMessage }` (and
  optional `runtime.error`).
- `session.execution.interrupted` → `turn.aborted`.
- `session.text.started` → `item.started`; deltas → `content.delta` (`assistant_text`);
  `ended` reconciles full text and completes the item. Item id =
  `${assistantMessageID}:${ordinal}`.
- `session.reasoning.*` → `content.delta` (`reasoning_text`) with the same fragment id.
- `session.renamed` → `thread.metadata.updated` when a title is present. Do not handle
  `session.updated`.
- Convert event `created` (ms) to ISO `createdAt`.

**Tools**

- Live events use **`id`**, not `callID`.
- Correlate `assistantMessageID` + `id`. Cache `name` from `session.tool.input.started`.
  On adopt without that event, recover name from projected messages; otherwise emit a
  generic tool item rather than dropping the lifecycle.
- Emit `item.started` / `item.updated` / `item.completed` with `toToolLifecycleItemType`.

**Permissions**

- `permission.asked` / `permission.replied` → `request.opened` / `request.resolved`.
- Map live `action` / `resources` / `metadata`. Reply
  `{ reply: "once"|"always"|"reject" }` via
  `POST /api/session/:sid/permission/:requestID/reply`.
- Recover pending permissions with `GET /api/session/:sid/permission` on start / adopt.

**Forms (issue 103)**

- `form.created` → `user-input.requested` with `requestId = form.id`.
- Each question `id` is `field.key`.
- `form.replied` / `form.cancelled` → `user-input.resolved`.
- After successful `POST /api/session/:sid/form/:id/reply`, synthesize resolve if SSE is
  missed; dedupe.
- Hydrate with `GET /api/session/:sid/form` **after** SSE subscribe + `server.connected`.
- Representable field mapping and `{ [field.key]: Value }` reply body as below.
- Surface `metadata.kind === "question"` fully, plus extra session-owned
  string/multiselect fields that are representable. Skip number, integer,
  boolean, external, `when`-conditional, and extra `custom: false` fields.
- If a form mixes representable and skipped fields, show only the representable
  ones. Submit sends mapped answers only; leftover required fields fail at the
  live form API and that error is surfaced.

**Binding**

- Probe the legacy `opencode` instance (binary **or** `serverUrl` health).
- If v2, materialize `opencodeV2` and mark `opencode` unavailable with a clear reason.
- Resume requires an explicit persisted-identity migration (see Migration). Continuation
  grouping is not a fallback.

**Driver completeness**

- Native v2 snapshot / inventory / probe presentation (`opencode2`).
- Native v2 text generation, so the compatibility client can be deleted.
- Capability-based durable detach, cursor settlement, and startup recovery.

**Web**

- Register `opencodeV2` on every hard-coded driver surface listed above.
- Keep zero-option (custom-only) questions instead of dropping them.

**Tests + integrated web verification** of the form flow and a representative v2 turn
(text + one tool + form + resume), after a deterministic mock service exists.

## Out of scope

- Redesigning the generic question UI or other providers’ ask-user behavior, unless the
  form-scope option later expands this issue.
- Changing the shuvcode fork.
- Surfacing non-session forms (`sessionID: "global"`).
- Leftover `question.*` HTTP / events on v2 (live tool path is `form.*`). Follow-up if a
  plugin still publishes `question.asked`.
- Compaction / shell / skill / input-queue / subagent UX beyond what is required to keep a
  turn from getting stuck (`session.compaction.*`, `session.shell.*`, `session.input.*`,
  `session.skill.activated` may be logged as native events and otherwise ignored in this
  issue).
- Mobile-specific UI.
- Dropping v1 support.

## Architecture

```
v1 binary/server ──▶ OpenCodeDriver ("opencode", display "OpenCode")
                       createOpencodeClient (@opencode-ai/sdk/v2, v1 protocol)
                       OpenCodeAdapter (question.asked → user-input.requested)
                       refuse v2 binaries and v2 serverUrl

v2 binary/server ──▶ OpenCodeV2Driver ("opencodeV2", display "opencode2")
                       OpenCodeV2Client (typed HTTP + SSE vs live /api)
                       OpenCodeV2Adapter / OpenCodeV2Provider / OpenCodeV2TextGeneration
                       ──▶ existing ingestion / projection / pending-input UI
```

Form → `UserInputQuestion` (v2 adapter; representable string/multiselect fields):

```ts
{
  id: field.key, // q0, q1, … — never form.id
  header: field.title ?? form.title ?? field.key,
  question: field.description ?? field.title ?? form.title ?? field.key,
  options: (field.options ?? []).map(o => ({
    label: o.label,
    description: o.description ?? o.label,
  })),
  multiSelect: field.type === "multiselect",
}
```

`user-input.requested.requestId` is `form.id`.

Reply (question-tool / value===label case):

```ts
{ answer: { [field.key]: "label-or-custom" | ["a", "b"] } }
```

Question-tool options set `value === label`, so labels may be submitted. Extra
string/multiselect fields are surfaced only when they are representable
(no `when`, and not extra `custom: false`). Do not coerce number / boolean /
external fields.

## Migration / instance binding

`ProviderDriverKind` is open. `defaultInstanceIdForDriver("opencodeV2")` is `"opencodeV2"`.
Legacy hydration copies `settings.providers.opencode` onto instance `opencode` and does
**not** move a v2 binary by itself.

1. A dedicated binding service (not `ProviderInstanceRegistryHydration.ts`) probes after
   hydration and on settings changes. Subscribe before the first read. Serialize probes.
   Inconclusive / unreachable / auth-failed probes leave both instances alone.
2. Probe rule:
   - `serverUrl` present → health-detect protocol with password.
   - else → `detectOpenCodeProtocolFromVersionOutput`, then attach only to that
     binary’s exact service registration. Do not scan another healthy channel.
3. If v2:
   - Create / reuse `opencodeV2`. Copy `binaryPath` / `serverUrl` / `serverPassword` from
     legacy config. Copy `environment` / `displayName` / `accentColor` / `enabled` only
     from an explicit `providerInstances.opencode` envelope.
   - Mark `opencode` unavailable: “this binary/server speaks OpenCode v2; use the
     opencode2 provider.”
   - Persist the generated v2 instance so restart does not depend on a live probe.
4. After a **conclusive v2 probe only**, rewrite persisted identity onto
   `opencodeV2` for affected threads:
   - `provider_session_runtime.provider_name` / `provider_instance_id`
   - projected thread session `providerName` / `providerInstanceId`
   - persisted thread `modelSelection.instanceId`
   Prefer an orchestration event that projectors already understand over a raw SQL patch
   of projections alone. Leave true v1 rows alone. Keep the old `opencode`
   instance visible and unavailable.
5. If v1, leave `opencode` alone; do not create `opencodeV2` unless the user adds one.

Do not delete `settings.providers.opencode`.

Shared-service shutdown: registry/driver scope close and process shutdown detach SSE only.
Do not abort shared-service work. Explicit user stop/interrupt may call
`session.interrupt`.

## Milestones

Run only the focused tests listed. No repo-wide suites.

### M0 — Pin the live v2 surface (spike, no product change)

Read-only against `/home/shuv/repos/shuvcode/packages/protocol/openapi.json` and
`packages/protocol/src/groups/{event,form,session,permission}.ts`.

Exit: route + event table in the M1 commit message (SSE subscribe, session CRUD / prompt /
**interrupt** / wait / active, form list / reply / cancel, permission list / reply). Confirm
`@opencode-ai/sdk@1.15.13` cannot decode `form.created`. If it suddenly can, stop and
reassess.

### M1 — Register `opencodeV2` / display `opencode2`; stop sending v2 through the v1 adapter

Files:

- Modify: `apps/server/src/provider/builtInDrivers.ts`
- Modify: `apps/server/src/provider/Drivers/OpenCodeDriver.ts`
- Create: `apps/server/src/provider/Drivers/OpenCodeV2Driver.ts`
- Create: binding service/layer (not a network call inside
  `ProviderInstanceRegistryHydration.ts`)
- Modify: `packages/contracts/src/settings.ts` (`OpenCodeV2Settings`,
  `OpenCodeV2SettingsPatch`, `providers.opencodeV2` on both settings and patch)
- Modify: `packages/contracts/src/model.ts` (`DEFAULT_MODEL_BY_PROVIDER`,
  `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`,
  `PROVIDER_DISPLAY_NAMES`)
- Modify: web driver registries listed in correction 26
- Modify: `ProviderService` durable-lifecycle hard-codes to a capability
- Test: registry, hydration/binding, settings patch, `ProviderService` detach/startup
  recovery, `ProviderCommandReactor` migrated-thread routing, web driver-meta tests

Tasks:

1. Add the driver to `BUILT_IN_DRIVERS`. `metadata.displayName: "opencode2"`.
   `supportsMultipleInstances: false`. Maintenance package stays `shuvcode`
   with `provider: opencodeV2`. Attach only to the probed binary’s exact
   service registration; do not scan another healthy channel.
2. V1 driver fails closed on a v2 binary **and** a v2 `serverUrl` in adapter, snapshot,
   and text generation.
3. Probe + bind rule above, with tests for v2-on-legacy-slot, v1-unchanged, serverUrl
   health, and inconclusive probe.
4. After a conclusive v2 probe, rewrite persisted identity onto `opencodeV2` and
   prove it with a cold-restart test. Do not start M2 until that test exists.
5. Adapter in this milestone may be a stub that cannot yet run a turn. Prefer that over
   copying `createOpenCodeV2CompatibilityClient`. Snapshot/text-generation may still be
   stubs that fail closed rather than calling the compatibility client.

Validation:

```
vp test run \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts \
  packages/contracts/src/settings.test.ts
```

plus touched hydration / binding / OpenCodeDriver / ProviderService /
ProviderCommandReactor / web registry tests.

### M2 — Native v2 client + inventory + text generation + adapter (includes issue 103)

Files:

- Create: `apps/server/src/provider/opencodeV2Client.ts` (+ test)
- Create: `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts` (+ test)
- Create: native v2 snapshot/inventory and text-generation modules (+ tests)
- Modify: `OpenCodeV2Driver.ts` to construct them
- Lift shared helpers from `opencodeRuntime.ts` / `OpenCodeAdapter.ts` only when they are
  protocol-agnostic (`toToolLifecycleItemType`, attachment parts). Do not lift event
  rewriting. Do not reuse the v1 resume-cursor shape without a `kind` discriminator.

**Client tests (live shapes)**

- SSE yields live envelopes, including durable `session.execution.*`,
  `form.created` with nested `data.form.sessionID`, and `session.tool.success` with
  `data.id` (not `callID`). Convert `created` ms → ISO.
- `form.list` / `form.reply` / `form.cancel` and `permission.list` / `permission.reply`
  hit the live routes and unwrap `{ data }`.
- Session prompt / **interrupt** / wait / active / fork (`boundary`) as used by start /
  adopt / resume.

**Adapter tests (tests first)**

- Session filter sees nested `form.sessionID` (regression vs today’s silent drop).
- Multi-field form: distinct `field.key` ids; reply `{ q0, q1 }`.
- `form.created` → `user-input.requested`; HTTP success resolves even if SSE
  `form.replied` is dropped; `form.cancelled` resolves; start / adopt recovery + dedupe
  across list-then-SSE and SSE-then-list.
- Subscribe-first hydration: form/permission created during boot buffer is not lost.
- `session.text.*` / `session.reasoning.*` start items, emit deltas, reconcile `ended`.
- `session.tool.*` with `id` produces item lifecycle, including terminal events without a
  preceding local `input.started`.
- `permission.asked` live shape opens a request; reply maps
  accept → `once`, acceptForSession → `always`, decline/cancel → `reject`; adopt recovers
  pending permissions.
- `session.execution.*` starts / settles the stored turn id.
- Ignore `sessionID === "global"` forms.
- Resume cursor `{ kind: "opencode-v2", ... }` re-adopts an in-flight v2 session.

Reuse buffer-limit / too-large errors if they are protocol-agnostic. Do not reuse
`normalizeV2Events`.

Validation:

```
vp test run \
  apps/server/src/provider/opencodeV2Client.test.ts \
  apps/server/src/provider/Layers/OpenCodeV2Adapter.test.ts
```

plus native inventory / text-generation / ProviderService recovery tests.

After this lands, grep production for `createOpenCodeV2CompatibilityClient` /
`opencodeV2Compatibility`. If only tests remain, delete the module in the same change or
immediately after.

### M3 — Web: zero-option custom-only questions + driver visibility

- Modify: `apps/web/src/session-logic.ts` (`parseUserInputQuestions`).
- Modify remaining hard-coded driver lists if M1 missed any.
- Test: parser, `pendingUserInput`, session-logic, and a composer/UI-path case for
  zero-option custom-only submit.

Validation: `vp test run` on the touched web test files.

### M4 — Integrated verification

First: a deterministic mock v2 service that can emit text, one tool, a question form,
accept a reply, drop the resolving SSE event, and survive process restart.

Then `test-shuv2code-app`. Isolated env, pairing URL, controlled browser.

1. Picker / settings show **opencode2** (or the user’s override), not a dead v1 OpenCode
   instance, when the binary/server is v2.
2. A normal turn streams assistant text and at least one tool item (proves v2 tool `id`
   handling).
3. Prompt the question tool for single-select, multi-select, and a custom answer.
4. Prompt appears; sidebar waits on input, not only “Working”.
5. Submit all three; turn resumes; summary matches.
6. Mid-prompt refresh + navigate away / back; prompt persists. Draft answers may reset;
   the prompt itself must not disappear.
7. Restart the dev server on a pending prompt; re-adopt; answer still works.

Stop the dev server when done.

## Risks

- **Larger than size:M.** Broad v2 support is required; keep compaction / shell / queued-input
  as native-log-only in this issue.
- **Thread / resume binding.** M1 must prove the chosen persisted-identity migration with a
  cold-restart test before M2 starts.
- **Published SDK drift.** A future official v2 client is a later swap, not a blocker.
- **SSE volatility.** Subscribe-first + list-on-adopt covers restart and the subscribe/list
  race. Mid-session drops after a successful reply are handled by local synthesize/reconcile.
  Broader mid-session poll remains a follow-up.
- **Protocol detection.** Pin tests to `shuvcode v0.0.0-integration-v2-202608121817` and a
  real v1 `1.x.y` string.

## Rollback

Additive driver. Revert v2 driver + probe/binding and restore the v1 driver’s v2-compat
branch if needed. Optional `providers.opencodeV2` is safe to drop. Do not delete
`opencodeV2Compatibility.ts` until production callers are gone.

## Settled choices

1. **Display name.** **`opencode2`**. Binary and display name stay user-overridable.
2. **Leftover `question.*` on v2.** Ignore in this issue.
3. **Native v2 text generation.** Implement it so the compatibility client can be deleted.
4. **Form scope.** Question-tool forms plus best-effort extra string/multiselect
   fields. Skip number, integer, boolean, external, `when`-conditional, and extra
   `custom: false` fields.
5. **Mixed forms.** Surface representable fields only. Submit mapped answers only.
   Leftover required fields fail at the live API; surface that error. Do not invent
   defaults for skipped fields.
6. **Migration.** After a conclusive v2 probe, rewrite runtime + projection +
   `modelSelection.instanceId` onto `opencodeV2`. Keep the old `opencode` instance
   visible and unavailable. Continuation grouping is not a fallback.
7. **Multiple instances.** `supportsMultipleInstances: false`.
8. **Service attach.** Exact probed registration only. Do not scan another healthy
   v2 service.

Follow-up after this issue: poll forms while a `question` tool is started if SSE drops
recur beyond reply/adopt; compaction / shell / input-queue UX on the v2 adapter;
typed generic form contracts/UI.
