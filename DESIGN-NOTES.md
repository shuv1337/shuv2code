# ADE model resolution — shared contract (DESIGN)

Workspace: `/home/shuv/.cache/agent-ws/model-resolution` (jj workspace `modelres`, parent
`ade-v1@origin` = `7cbbc58d`). `pnpm install --ignore-scripts` has been run there;
`./node_modules/.bin/vp` and `./node_modules/.bin/tsgo` resolve. Scratch file — FIX agent deletes it.

## 1. Kernel default discovery — decision

**Use `GET /api/model/default`.** It exists today and is exactly the operator's `model:` setting.

Evidence (read-only clone `/home/shuv/repos/shuvcode`, branch integration-v2):

- `packages/protocol/src/groups/model.ts:26-38` — `HttpApiEndpoint.get("model.default", "/api/model/default", { query: LocationQuery, success: Location.response(Schema.UndefinedOr(Model.Info)), error: ServiceUnavailableError })`, summary "Retrieve the model used when a session has no explicit model selection."
- `packages/server/src/handlers/model.ts:27-34` — handler is `response(catalog.model.default())`.
- `packages/core/src/catalog.ts:196-207` — resolution: if `state.defaultModel` is set **and** its provider is available **and** the model is `enabled`, return it; **otherwise return `model.available()[0]`** (release-date-descending).
- `packages/core/src/config/plugin/provider.ts:43-45` — `state.defaultModel` is populated from `Config.latest(entries, "model")`, i.e. the `model:` key of `opencode.json`. Nothing writes it when the operator sets nothing.

**Shape when the operator set nothing:** the endpoint still returns a model — the newest available+enabled
one — not `undefined`. So the kernel default is _advisory, not authoritative_: it can itself be
`openai/chatgpt-image-latest`. It must be run through the capability filter like every other candidate.
`undefined` only occurs when the catalog is empty.

**Ranking of sources (all inspected):**

1. `GET /api/model/default` — the only endpoint that reflects `model:`. **Use it.**
2. `GET /api/model` entries — `Model.Info` carries no default/priority flag
   (`packages/schema/src/model.ts:89-114`: `id, modelID, providerID, family, name, compatibility,
package, capabilities, variants, time.released, cost, status, enabled, limit`). Order is
   release-date descending (`catalog.ts:180-193`), which is _why_ `models[0]` drifted from
   `opencode/big-pickle` to `openai/chatgpt-image-latest` after a cache clear. Not a default signal.
3. `GET /api/agent` — agents carry a model override, but that is a per-agent override, not the
   operator default, and ADE does not select an agent at session start. Ignore.
4. `GET /api/provider` — no default model field. Ignore.
5. `GET /api/config` (`packages/protocol/src/groups/config.ts:8`) returns raw `Config.Entry` documents
   lowest-to-highest priority. It _contains_ `model:` but requires shuv2code to re-implement
   `Config.latest` precedence. Strictly worse than 1. **Do not use.**

`small_model:` is deliberately out of scope — `catalog.model.small` (`catalog.ts:210-230`) is a
family-priority heuristic per provider with no config key behind it, and ADE has no small-model need.

**Plumbing:** add to `apps/server/src/provider/opencodeV2Client.ts` (~line 580, next to `model.list`):

```ts
model: {
  list: () => request<{ data: ReadonlyArray<unknown> }>("GET", "/api/model", { query: { location } }),
  default: () => request<{ data: unknown }>("GET", "/api/model/default", { query: { location } }),
},
```

`Location.response` wraps in `{ data }`, matching the existing `list` typing. A 404/`ServiceUnavailable`
from an older kernel build must be treated as "no kernel default" (fall through), never as a hard failure.

## 2. Capability plumbing — decision

**Extend `ModelCapabilities` with two optional booleans.** Do not touch `ServerProviderModel`'s field list.

`packages/contracts/src/model.ts:125`:

```ts
export const ModelCapabilities = Schema.Struct({
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
  /** Provider-reported tool-calling support. Absent = unreported, not "no". */
  toolCalling: Schema.optional(Schema.Boolean),
  /** Provider-reported text output. Absent = unreported, not "no". */
  textOutput: Schema.optional(Schema.Boolean),
});
```

Both `Schema.optional`, so every payload minted before this change still decodes and
`ServerProviderModel.capabilities: Schema.NullOr(ModelCapabilities)` is unchanged.

`packages/shared/src/model.ts:20-26` — widen the factory, keep the current call shape legal:

```ts
export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  toolCalling?: boolean;
  textOutput?: boolean;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
    ...(input.toolCalling === undefined ? {} : { toolCalling: input.toolCalling }),
    ...(input.textOutput === undefined ? {} : { textOutput: input.textOutput }),
  };
}
```

Also add the single predicate both implementers use (same file, exported from `@shuv2code/shared/model`):

```ts
/**
 * Can this model run an agent turn? Only an explicit provider `false`
 * disqualifies: most drivers report nothing, and treating silence as "no"
 * would empty their catalogs.
 */
export function isAgentCapableModel(model: ServerProviderModel): boolean {
  const caps = model.capabilities;
  if (caps === null || caps === undefined) return true;
  return caps.toolCalling !== false && caps.textOutput !== false;
}
```

**Absent data means "assume capable".** Justification: the asymmetry of failures. A false _negative_
(silence read as incapable) makes Codex, Claude, Cursor, Grok and every custom model instantly
unselectable, i.e. it bricks the product for providers that never had this bug. A false _positive_
(an incapable model slips through) degrades to exactly today's behaviour plus the item-4 liar notice,
which is strictly better than today. Only shuvcode reports `capabilities` today, so only shuvcode
models can be excluded — which is precisely the surface with the bug.

### Every `createModelCapabilities` call site (must keep compiling — all pass only `optionDescriptors`, so all keep compiling unchanged)

- `apps/server/src/provider/Layers/CodexProvider.ts:179`
- `apps/server/src/provider/Layers/OpenCodeV2Provider.ts:30` (`DEFAULT_CAPABILITIES`) and `:129`
- `apps/web/src/providerModels.ts`
- `packages/shared/src/model.ts` (definition) and `packages/shared/src/model.test.ts`
- tests: `apps/server/src/provider/Layers/ProviderRegistry.test.ts:272,577,787,809,913`,
  `apps/server/src/provider/makeManagedServerProvider.test.ts:24,26`,
  `apps/server/src/provider/providerSnapshot.test.ts:20,58`,
  `apps/server/src/provider/providerStatusCache.test.ts:22`
- (`OpenCodeProvider.ts`, `CursorProvider.ts`, `ClaudeProvider.ts`, `GrokProvider.ts` appear only in the
  stale `.claude/worktrees/` copies on this tip — do not edit those paths.)

### Every reader of `ServerProviderModel.capabilities` (must keep compiling)

- `apps/server/src/provider/Layers/ProviderRegistry.ts:78-79` — `hasModelCapabilities` = "has option
  descriptors". **Leave the predicate reading `optionDescriptors` only.** It drives
  `mergeProviderModels` (`:81-101`), which preserves a previous snapshot's descriptors when the new one
  has none; widening it to the new booleans would make a descriptor-less-but-tool-capable model look
  "rich" and stop that recovery.
- `apps/server/src/provider/Layers/CodexProvider.ts:238` — `fallbackCapabilities` picks the first
  non-null capabilities blob. Unchanged.
- `apps/server/src/provider/providerSnapshot.ts:154-178` — `providerModelsFromSettings` stamps
  `customModelCapabilities` onto custom models. Custom models stay `{ optionDescriptors: [] }`,
  i.e. unreported ⇒ capable. Correct: a hand-typed custom slug must not be filtered out.
- `apps/web/src/providerModels.ts:86`
- `apps/mobile/src/lib/providerOptions.ts:16-20`, `apps/mobile/src/lib/modelOptions.ts:129-147`,
  `apps/mobile/src/features/threads/ThreadComposer.tsx:624`,
  `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx:394,1225`
  — all read `capabilities` only to derive option selects. Additive optional fields are invisible to them.

### Producer change

`apps/server/src/provider/Layers/OpenCodeV2Provider.ts`:

- `V2ModelSchema` (`:38-45`) gains
  `capabilities: Schema.optionalKey(Schema.Struct({ tools: Schema.optionalKey(Schema.Boolean), output: Schema.optionalKey(Schema.Array(Schema.String)) }))`.
- `openCodeV2ModelsFromInventory` (`:106-152`) passes
  `toolCalling: model.capabilities?.tools`,
  `textOutput: model.capabilities?.output === undefined ? undefined : model.capabilities.output.some((o) => o.startsWith("text"))`
  into `createModelCapabilities`.
- The same function gains a `defaultSlug?: string` input and stamps `isDefault: true` on the matching
  model (`ServerProviderModel.isDefault` already exists at `packages/contracts/src/server.ts:69` and is
  unused for models today). The inventory `Effect.all` at `:214-227` adds
  `client.model.default()` with `Effect.orElseSucceed(() => undefined)` so an older kernel degrades silently.

## 3. Resolution order — decision

`apps/server/src/ade/AdeShuvcodeChatSession.ts` `resolveModelSelection` (`:179-208`). New signature:

```ts
resolveModelSelection(input: {
  readonly pinned: ModelSelection | null | undefined;   // the bot's own setting (see below)
  readonly projectDefault: ModelSelection | null | undefined;
})
```

Order, first hit wins:

1. **Explicit ADE setting (`pinned`)** — accepted whenever `instanceId === ADE_SHUVCODE_INSTANCE_ID`,
   _without_ a capability veto (see below).
2. **Project default** — `project.defaultModelSelection`, accepted only when
   `instanceId === ADE_SHUVCODE_INSTANCE_ID` (existing rule at `:181`, keep the comment) **and** the slug
   resolves to a model passing `isAgentCapableModel`. A project default that fails the filter is skipped,
   not fatal — it may have been written before this change (the hand-edited
   `projection_projects.default_model_selection_json` rows on the VM are exactly that).
3. **Kernel-configured default** — the model flagged `isDefault` in the refreshed instance snapshot,
   if it passes `isAgentCapableModel`.
4. **First capability-passing model** — `instance.models.find(isAgentCapableModel)`. Note this is now a
   _filtered_ first, not `instance.models[0]`.
5. **Named failure** — see §4. Never `instance.models[0]`.

Steps 2–4 all consult the same refreshed `instance.models`; keep the existing empty-catalog refresh
(`:184-189`) and the two existing `unavailable(...)` messages for "no instance" (`:191-195`) and
"instance reports no models" (`:197-203`) exactly as they are — they name different problems.

### Where the explicit ADE setting is stored — decision

**On the bot's own chat thread, as `OrchestrationThreadShell.modelSelection`, written with
`thread.meta.update`.** Not `project.meta.update`.

- The thread id is deterministic (`adeBotThreadId`, `AdeShuvcodeChatSession.ts:77` →
  `ade-bot-<botId>`), the thread is created once by `prepareThread` (`:449-471`) already carrying a
  `modelSelection`, and `thread.meta.update` already accepts `modelSelection`
  (`packages/contracts/src/orchestration.ts:818-826`).
- `OrchestrationThreadShell.modelSelection` (`packages/contracts/src/orchestration.ts:481-486`) is a
  required field on the shell snapshot `prepareThread` already reads
  (`shell.threads.some(t => t.id === threadId)`, `:447-448`). Reading `pinned` costs a `.find` on data
  already in hand — no new table, no migration, no new projection.
- `project.meta.update`'s `defaultModelSelection` is **project-scoped**: every bot whose repo maps to
  the same `ade-project-<hash>` shares it (`AdeShuvcodeChatSession.ts:296-335`). Per-bot model choice is
  the requirement, so the project default stays what it is — a default — and becomes step 2.

`prepareThread` change: after the existence check, read
`const pinned = shell.threads.find((t) => t.id === threadId)?.modelSelection ?? null;` and call
`resolveModelSelection({ pinned, projectDefault: project.defaultModelSelection })`. On the create branch
`pinned` is `null` by construction. The resolved selection continues to flow into `thread.create`
(`:461`) and `sessions.startSession` (`:493`).

### A pinned model that fails the capability filter — decision

**Use it, and warn.** Do not refuse.

Rationale: the capability block is provider-reported and can be wrong, stale, or absent for a model the
captain knows works; refusing would turn a deliberate choice into an unusable dead end with no override
anywhere in the product. Instead: use the pin, and emit the item-4 notice for the session with copy that
names the pin. The liar detector (§5) is the backstop that catches the case where the pin really is wrong.
Log once at `Effect.logWarning` with `{ botId, slug, reason: "pinned-model-not-agent-capable" }`.

## 4. Error surface — decision

New `AdeCaptainError` reason, added to the literal union at `packages/contracts/src/ade.ts:977-1000`:

```
"model_not_agent_capable"
```

Raised from `resolveModelSelection` step 5 via the existing `unavailable`-style helper (a new
`modelNotCapable` local mirroring `unavailable` at `AdeShuvcodeChatSession.ts:82-83`), with `message`
(the _disclosure_ half):

> `The shuvcode kernel offers N models and none of them report tool calling and text output. Set "model" in your opencode.json to a tool-capable model (for example an openai/gpt-* or anthropic/claude-* entry), restart \`shuvcode service\`, then reopen this conversation.`

Headline (the sentence the captain reads), added to `CAPTAIN_ERROR_TEXT` in
`apps/web/src/state/ade.logic.ts` (the record around `:60-89`, which is exhaustive over the reason union
and therefore **must** be extended or web typecheck breaks):

```ts
model_not_agent_capable: "No model on this kernel can run this bot.",
```

**Where it renders:** nowhere new. `botChatStartNotice` (`apps/web/src/components/fleet/BotChatPage.logic.ts:285-288`)
already turns any `AdeCaptainError` into a `BotChatConnectNotice` via `adeCaptainErrorParts`
(`ade.logic.ts:127-137`), and `resolveBotChatConnectState` (`:242-282`) renders it through
`BotChatConnectNoticeStrip` (`apps/web/src/components/fleet/BotChatConnect.tsx:28`) over the
conversation shell. Headline is primary copy; the remediation sentence lands in the collapsed
"Details" disclosure — the house style established by `BOT_CHAT_KERNEL_DOWN_NOTICE`
(`BotChatPage.logic.ts:208-213`).

**Pinned-but-incapable warning** (not an error — the session starts): a second module-level notice next
to `BOT_CHAT_TOOLS_MISSING_NOTICE` (`BotChatPage.logic.ts:320-326`), rendered by the same
`BotChatConnectNoticeStrip tone="muted"` line at `BotChatPage.tsx:419`, gated on a new
`AdeBotChatSession` field (see §5 for the field, one field serves both):

- message: `"This bot's model may not be able to use tools."`
- details: `"<slug> does not report tool calling on this kernel. If the bot stops delegating or loops, pick a different model."`

## 5. Liar detection — decision

**The signal does reach the server today. No new wire format is needed; what is missing is a counter and
a route from the adapter's dispatch seam to ADE.**

Trace:

1. Kernel: `packages/core/src/session/runner/publish-llm-event.ts:294-316` — `failMalformedToolInput`
   publishes `SessionEvent.Tool.Failed` with
   `error: { type: "tool.input-json", message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON." }`, `executed: false`.
2. Wire: that arrives at shuv2code as SSE event `session.tool.failed`.
3. Adapter: `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts:1043-1111` handles
   `session.tool.failed`, and at `:1103-1108` spreads the raw `...data` into the emitted
   `item.completed` payload's `data`. So `payload.data.error.type === "tool.input-json"` is already
   observable — but only as an opaque timeline item nobody inspects. That is why the loop was silent.

**Smallest plumbing (3 edits, no new service, no new table):**

- `apps/server/src/provider/Services/ProviderDynamicTools.ts:49-51` — add a third signal variant:
  ```ts
  | { readonly kind: "input-malformed"; readonly threadId: ThreadId; readonly tool: string }
  ```
  This queue (`takeSignal`, `:103`) is documented single-consumer, lossless, and buffered — exactly the
  guarantees a counter wants.
- `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts` — inside the existing `session.tool.failed`
  branch, when `asRecord(data.error)?.type === "tool.input-json"`, also
  `yield* Queue.offer(dynamicToolSignals, { kind: "input-malformed", threadId: context.session.threadId, tool: name })`.
  The queue is already in scope (`:451`) and already offered to from this switch (`:1173`).
- `apps/server/src/ade/AdeToolGate.ts` `runShuvcodeDispatchLoop` (`:1264-1293`) — handle the new kind
  before the `signal.call` deref (which would otherwise be `undefined`), by calling a new optional hook
  on the existing `AdeShuvcodeLoopOptions` bag:
  `onMalformedToolInput?: (input: { threadId: ThreadId; tool: string }) => Effect.Effect<void>`.
  The gate must not gain an `OrchestrationEngineService` dependency (it is constructed by
  `AdeToolGate.layer` with only `AdeToolHandlers | AdeToolInlineChecks | AdeScreenboxToolPlane`,
  `:830-842`); the hook is what keeps that layering intact.
  `AdeShuvcodeDispatchLoop.live` (`apps/server/src/ade/AdeShuvcodeDispatchLoop.ts:25-33`) supplies the
  hook and is free to take the extra dependency, because it is the layer that already owns "where the
  loop is forked".

**Counter semantics:**

- **Scope:** per bot primary session, keyed by `ThreadId` (`ade-bot-<botId>` is 1:1 with a bot's primary
  chat). Hold it in the in-memory map owned by the same holder as the hook — malformed-JSON looping is a
  live-session symptom, and a counter that outlives the process would accuse a session that no longer exists.
- **Threshold:** 3 malformed tool inputs on one thread. One is noise (any model mis-emits occasionally);
  two is bad luck; three inside one session is the loop the captain watched on the VM.
- **Latched:** the notice fires once per session and the counter is not re-armed — repeating it would
  spam a conversation that is already failing.
- **Reset:** on `rebindShuvcodeSession` for that thread (already called on every start and every rollover,
  `AdeShuvcodeChatSession.ts:537-540, 552-555`) and on `closeBinding`. Practically: a new primary session,
  a rollover, or a kernel restart clears it. Server restart clears it too, which is correct.

**Notice text** (same `BotChatConnectNotice` shape, same strip as §4's warning; delivered on the
`AdeBotChatSession` payload so the strip has it without a new subscription):

- message: `"This bot's model isn't calling tools correctly."`
- details: `"<slug> returned malformed tool-call arguments 3 times in this session — the fleet tools were never run. Pick a different model for this bot; the change applies the next time this conversation is restarted."`

**Contract carrier:** one new optional field on `AdeBotChatSession`
(`packages/contracts/src/ade.ts:893-960`), following the `toolsProbe` precedent exactly — optional on
`AdeBotChatSessionSource`, defaulted in the `decodeTo` transform, required on `AdeBotChatSessionWire`:

```ts
modelHealth: Schema.optional(Schema.Literals(["ok", "unreported-tools", "malformed-tool-input"]));
// wire default: "ok"
```

`unreported-tools` is set at start (§4's pinned-but-incapable case). `malformed-tool-input` is set when
the counter latches; it outranks `unreported-tools`. `AdeBotChatSession` is re-read on reconnect, which
is when the strip updates — acceptable and consistent with `toolsProbe`, whose doc comment already says
it is a start-time snapshot (`BotChatPage.logic.ts:308-318`).

## 6. Item-5 surface — decision

- **RPC: a new `ade.setBotModel`.** Not a reuse of `ade.updateBotIdentity`
  (`AdeCaptainApi.ts:504-506`, impl `:998-1055`) and not a raw `thread.meta.update` from the client.
  `updateBotIdentity` is documented as _the captain's editable label_ and its impl is one `UPDATE
ade_bots` statement; the model lives on the thread, needs an orchestration dispatch, and needs a
  rollover decision. Folding it in would give one RPC two storage backends and two failure modes.
  - `packages/contracts/src/rpc.ts`: `WS_METHODS.adeSetBotModel = "ade.setBotModel"` (next to
    `adeUpdateBotIdentity` at `:441`) and `WsAdeSetBotModelRpc = Rpc.make(..., { payload: AdeSetBotModelInput, success: AdeBotModelSetting, error: AdeCaptainRpcError })`.
  - `packages/contracts/src/ade.ts`:
    `AdeSetBotModelInput = Schema.Struct({ botId: BotId, modelSelection: ModelSelection })` and
    `AdeBotModelSetting = Schema.Struct({ botId: BotId, modelSelection: ModelSelection, appliesToLiveSession: Schema.Boolean })`.
  - `apps/server/src/ade/AdeChatSessionPort.ts` gains `setBotModel`, implemented in
    `AdeShuvcodeChatSession.ts` (it is the only place that already holds `OrchestrationEngineService`,
    `ProjectionSnapshotQuery`, and `AdeSessionRollover`). `AdeCaptainApi` delegates to the port —
    the same shape as the `renamePrimaryChat` note already written at `AdeCaptainApi.ts:1046-1054`.
  - `apps/server/src/ws.ts` — register next to `WS_METHODS.adeUpdateBotIdentity` (`:453-459`).
  - Validation: reject with `model_not_agent_capable` only if the slug is not in the instance catalog at
    all; a catalog model that merely fails the capability filter is accepted (§3's pin rule) and comes
    back with `modelHealth: "unreported-tools"` on the next session.

- **UI affordance: the bot identity sheet** (`apps/web/src/components/captain/BotIdentitySheet.tsx`,
  forms in `BotIdentityForms.tsx`, logic in `botIdentity.logic.ts`, hook `useBotIdentity.ts`).
  Not project settings: the setting is per bot, the sheet is already the "everything about this bot"
  surface reachable from the conversation header, and project settings would imply the wrong scope
  (one repo = one `ade-project-<hash>` = many bots). Reuse `ProviderModelPicker`
  (`apps/web/src/components/chat/ProviderModelPicker.tsx`) filtered to `ADE_SHUVCODE_INSTANCE_ID`;
  models failing `isAgentCapableModel` render with a "may not support tools" hint but remain selectable.

- **Where the current model is displayed:** as a row in `BotSidePanel.tsx`
  (`apps/web/src/components/captain/BotSidePanel.tsx`) showing the model's display name with the
  identity sheet as the edit affordance — the panel is the bot's at-a-glance facts strip. Not the
  `ConversationHeader`: the header is already carrying name, role, project, and assignment counts.

- **Session semantics: "applies to the next session", plus an explicit opt-in rollover.**
  A live kernel session keeps the model it was created with, so the RPC's default path writes
  `thread.meta.update` and returns `appliesToLiveSession: false`; the sheet renders
  `"Applies the next time this conversation is restarted."` immediately under the picker.
  When there is an active primary binding the sheet additionally offers **"Restart with this model"**,
  which calls the same RPC with `restartSession: true`; the server then runs
  `AdeSessionRollover.rolloverPrimarySession` (`AdeSessionRollover.ts:331-340`, impl `:651`) so the new
  session carries a summary of the retired one, and returns `appliesToLiveSession: true`.
  Justification: silently rolling over on every model change would discard live context behind an
  innocuous-looking dropdown, while "applies next time" alone reproduces the reported symptom
  ("changing it appears to do nothing"). Naming the restart and making it a second, explicit tap
  resolves both.

## 7. Work split

Two implementers, one shared file each way, BACKEND lands first.

### BACKEND (ticket items 1–4: discovery, capabilities, resolution, error surface, liar detection)

- `packages/contracts/src/model.ts` — `ModelCapabilities` + 2 optional fields
- `packages/shared/src/model.ts` (+ `model.test.ts`) — `createModelCapabilities`, `isAgentCapableModel`
- `apps/server/src/provider/opencodeV2Client.ts` — `model.default`
- `apps/server/src/provider/Layers/OpenCodeV2Provider.ts` (+ `.test.ts`) — decode `capabilities`, stamp `isDefault`
- `apps/server/src/provider/Services/ProviderDynamicTools.ts` — `input-malformed` signal variant
- `apps/server/src/provider/Layers/OpenCodeV2Adapter.ts` (+ `.dynamicTools.test.ts`) — offer the signal
- `apps/server/src/ade/AdeToolGate.ts` (+ `.test.ts`) — `onMalformedToolInput` hook in `AdeShuvcodeLoopOptions`
- `apps/server/src/ade/AdeShuvcodeDispatchLoop.ts` — supply the hook, own the per-thread counter
- `apps/web/src/state/ade.logic.ts` — one line in `CAPTAIN_ERROR_TEXT`
- `apps/web/src/components/fleet/BotChatPage.logic.ts` (+ `.test.ts`) and `BotChatPage.tsx` — the two new
  notice constants and the `modelHealth` strip gate

### SURFACE (ticket item 5: setting the model)

- `packages/contracts/src/rpc.ts` — `adeSetBotModel` method + `WsAdeSetBotModelRpc`
- `apps/server/src/ade/AdeChatSessionPort.ts` — `setBotModel` on the port
- `apps/server/src/ade/AdeCaptainApi.ts` (+ `.test.ts`) — delegate
- `apps/server/src/ws.ts` — register the handler
- `apps/web/src/components/captain/BotIdentitySheet.tsx`, `BotIdentityForms.tsx`,
  `botIdentity.logic.ts` (+ `.test.ts`), `useBotIdentity.ts` — picker + copy + restart action
- `apps/web/src/components/captain/BotSidePanel.tsx` — current-model row
- `apps/web/src/state/ade.ts` (client RPC binding, wherever `adeUpdateBotIdentity` is called from)

### Files both must touch (exactly two)

1. **`packages/contracts/src/ade.ts`**
   - BACKEND, **first**: adds `"model_not_agent_capable"` to the `AdeCaptainError.reason` literal union
     (`:977-1000`) and adds the optional `modelHealth` field to `AdeBotChatSessionSource` /
     `AdeBotChatSessionWire` / the `decodeTo` transform (`:893-960`).
   - SURFACE, **after**: appends `AdeSetBotModelInput` / `AdeBotModelSetting` near
     `AdeUpdateBotIdentityInput` (`:1165-1176`).
   - Disjoint regions; SURFACE rebases onto BACKEND's commit before adding its structs.

2. **`apps/server/src/ade/AdeShuvcodeChatSession.ts`**
   - BACKEND, **first**: rewrites `resolveModelSelection` (`:179-208`), adds the `modelNotCapable`
     helper next to `unavailable` (`:82-83`), and changes the two call sites (`:305`, `:444`) plus the
     `pinned` read in `prepareThread`.
   - SURFACE, **after**: adds the `setBotModel` implementation as a new member of the returned port
     object (bottom of the layer), touching nothing BACKEND rewrote.
   - Same rule: SURFACE starts from BACKEND's commit.

Everything else is disjoint. `apps/web/src/components/fleet/BotChatPage.*` is BACKEND-only (notices);
`apps/web/src/components/captain/*` is SURFACE-only (setting).

### Verification both must run (workspace-local)

1. `./node_modules/.bin/vp test run <changed test files>`
2. `./node_modules/.bin/vp check --fix`
3. **after** the autofix: `./node_modules/.bin/tsgo --noEmit -p apps/server/tsconfig.json`,
   `-p packages/contracts/tsconfig.json`, `-p apps/web/tsconfig.json`
4. Grep your diff for the brand-check-banned three-character literal (uppercase T followed by the digit three); it must not appear.

Known pre-existing red, do not chase: the roster round-trip test in `packages/contracts/src/ade.test.ts`,
`049_VoiceSessionOwnership.test.ts`, and 10 typecheck errors under `apps/server/src/vcs/**` and
`apps/server/src/voice/Layers/**`.
