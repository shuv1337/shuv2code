# Issue #18 Real-Time Voice Thread Control Plan

## Issue and baseline

The requested GitHub issue number was `#17`, but `shuv1337/shuv2code#17` is the
already-merged release-preflight PR. The open voice orchestration proposal is
[#18, “Add a Codex voice orchestration agent for cross-thread control”](https://github.com/shuv1337/shuv2code/issues/18).
This plan targets #18.

The investigation used worktree commit
`1f6d2c4dfbc143f0c39fe4276bda73f20b816bec`. At plan time, `origin/main` was one
release-workflow-only commit ahead (`c5acae7b61185f4c77356226167315dde9b91723`);
the inspected voice, provider, orchestration, MCP, and client code was unchanged.

The confirmed v1 product boundary is:

- Live discovery/status for shuv2code-managed Codex threads in the controller's
  authorized environment, including projects that do not yet have a thread.
- Real mutation of managed Codex threads within an explicit, authenticated
  thread-control permission ceiling selected when the controller is created.
- A web-first voice client using Codex app-server WebRTC v3.
- Real provider-backed creation, live status, same-turn steering, and exact-turn
  interruption.
- External Codex Desktop/CLI threads that were not created by shuv2code are
  deferred to the shared-daemon follow-up.

## Required outcome

A user starts an unprivileged realtime voice transport session backed by one
dedicated durable Codex controller thread and can say:

1. “Start a thread in project X to investigate Y.”
2. “What is it doing?”
3. “Actually, focus on the failing tests.”
4. “Stop that thread.”

The system must then:

- create exactly one persisted shuv2code thread;
- start exactly one real Codex provider thread and first turn for it;
- report status from live projections and provider events, not from guessed
  transcript text;
- call `turn/steer` on the target thread's existing app-server owner and retain
  the exact active turn ID;
- call `turn/interrupt` with that same expected turn ID;
- distinguish “command accepted” from “provider confirmed” in both the UI and
  speech;
- survive voice/WebSocket reconnects without replaying an accepted mutation; and
- never resume or manipulate the target through the controller's app-server
  process.

“Real” is therefore an end-to-end invariant, not a UI state:

- **Real creation:** one shuv thread, one provider thread, one initial provider
  turn.
- **Real status:** an authoritative projection sequence/timestamp plus current
  provider/session state.
- **Real steering:** app-server acknowledges `turn/steer`, the active provider
  turn ID is unchanged, and no second `turn/started` event appears.
- **Real interruption:** the expected active turn is interrupted; a stale request
  cannot cancel a newer turn.

## V1 boundaries

### In scope

- One immutable `voice-controller` thread purpose and one active controller per
  environment, transactionally designated in a chosen host project.
- Codex-only targets managed by shuv2code.
- A physically separate controller MCP endpoint whose static tool catalog
  contains only the controller's thread tools.
- Tools `thread_list`, `thread_get`, `thread_create`, `thread_send`, and
  `thread_interrupt`.
- `thread_create` with a required initial instruction, implemented as a
  retry-safe create-and-start saga.
- Explicit `thread.turn.steer` orchestration and provider operations.
- Bounded live target updates for accepted, starting, working, waiting for
  approval, waiting for input, completed, interrupted, failed, and stale.
- Web microphone capture, WebRTC negotiation, remote playback, transcript,
  mute, stop, reconnect, and an active-target tray.
- Electron main-window microphone permission plumbing because it hosts the same
  web client.
- Additive audit/outcome storage, strict redaction, immutable controller
  instructions, and independently switchable read/write feature flags.

### Deferred

- Codex Desktop/CLI threads outside shuv2code and the shared app-server daemon.
- Native mobile media support. V1 must keep contracts/client-runtime free of
  browser-only types and keep the mobile package typechecking; native voice is
  v1.1.
- WebSocket/PCM media fallback. Unsupported WebRTC produces a clear unavailable
  state and preserves text control.
- Non-Codex providers.
- Approval responses, permission widening, lifecycle delete/archive/rollback,
  attachments, worktree creation, group commands, wake words, background
  listening, and autonomous scheduling.
- Treating arbitrary narrative text as a canonical blocker. V1 can reliably
  report approvals, user-input waits, runtime errors, and explicitly projected
  failures.

## Current-state findings that drive the design

1. `packages/effect-codex-app-server/scripts/generate.ts` is pinned to an older
   upstream commit and generates the stable request union. Generated metadata
   includes all eight realtime notifications but omits all six realtime request
   methods. The generator must use one reviewed upstream revision and its
   experimental schema.
2. `apps/server/src/provider/Layers/CodexProvider.ts::buildCodexInitializeParams`
   already enables `experimentalApi`, but that does not enable or prove
   `realtime_conversation`. Runtime startup must probe
   `experimentalFeature/list` and `thread/realtime/listVoices`.
3. `apps/server/src/provider/Layers/CodexSessionRuntime.ts` routes realtime
   notifications but exposes neither realtime operations nor steering.
   `sendTurn` always calls `turn/start`.
4. `apps/server/src/provider/Layers/CodexAdapter.ts` currently maps realtime
   started, item-added, audio, error, and closed events, but drops transcript
   delta/done and SDP. Realtime audio is untyped.
5. `packages/contracts/src/orchestration.ts` has create, turn-start, and
   interrupt commands but no steer command.
6. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` drops the
   requested interrupt turn identity and interrupts by session, so a stale
   request can affect a newer turn.
7. The WebSocket bootstrap path in `apps/server/src/ws.ts` creates a thread and
   then starts it with freshly generated child IDs. A lost response can re-enter
   creation; it is not sufficient for voice reconnect idempotency.
8. `OrchestrationEngine` receipts prove durable command intent only. Provider
   effects run later and have only an in-memory 30-minute dedupe cache. Voice
   must not say “steered” based only on the intent receipt.
9. `ProjectionSnapshotQuery` already owns the required live status facts:
   session status, active turn ID, latest turn, pending approval/input, recent
   messages, activities, plans, and checkpoints.
10. Every MCP provider credential currently receives the same preview and
    automation capabilities. Cross-thread authority must use a closed
    controller credential profile, not a caller-supplied capability array.
11. Each Codex session owns a private `codex app-server` child. The controller
    child cannot safely become a second manager for a sibling rollout.
12. Native Codex events are currently logged before realtime payloads are
    classified. Audio, SDP, transcripts, and unstable realtime items need an
    explicit no-persist/no-log path before voice can ship.
13. The pinned Codex MCP client adds
    `params._meta["x-codex-turn-metadata"]` to custom-server `tools/call`
    requests, including provider `turn_id`, session/thread identity, and turn
    start time. The current Effect `McpSchema.RequestMeta` retains only
    `progressToken`, and `McpServer.callTool` passes handlers only
    `arguments`, so the existing transport discards the exact per-turn
    correlation voice mutations require.

## V1 ownership architecture

The controller is a conversational surface over shuv2code's existing authority,
not a new thread manager. V1 deliberately separates realtime media from
privileged control because the reviewed Codex protocol does not propagate an
automatic handoff's exact item identity into subsequent custom MCP calls.

1. An unprivileged `voice-transport` Codex runtime owns WebRTC and uses
   `clientManagedHandoffs: true`. It receives no controller MCP credential and
   cannot read or mutate sibling threads.
2. On each `handoff_request`, `VoiceControllerService` durably creates one
   server-owned `voiceActionId` from the transport generation and exact
   handoff/item identity.
3. The service serializes controller actions. It starts exactly one explicit
   turn on the durable `voice-controller` thread with
   `clientUserMessageId = voiceActionId`, records the returned provider turn
   ID, and does not steer that controller action turn. A busy controller queues
   later actions.
4. The controller turn calls the five scoped MCP tools. Trusted MCP
   `x-codex-turn-metadata.turn_id` maps to exactly one persisted action because
   one controller provider turn processes exactly one voice action.
5. `ThreadControlService` reads targets through `ProjectionSnapshotQuery` and
   writes through `OrchestrationEngine`.
6. `ProviderCommandReactor` resolves the target's existing provider session and
   calls `ProviderService`.
7. The target's own `CodexAdapter` selects its existing
   `CodexSessionRuntime`.
8. Only that target runtime calls `turn/start`, `turn/steer`, or
   `turn/interrupt` on its child.
9. Controller results and target watcher transitions return to
   `VoiceControllerService`, which supplies bounded context to the transport
   with `thread/realtime/appendText` and, after the M0 barge-in gate, one
   arbitrated `thread/realtime/appendSpeech`.

The controller process never receives a sibling's provider thread ID and never
calls `thread/resume` for a sibling. Steering uses `allowRecovery: false`; a
dead runtime cannot be recovered into an in-flight turn.

A future single-thread optimization may use automatic handoff only after the
minimum supported Codex version propagates a core-owned
`{ turn_id, client_user_message_id, handoff_id, handoff_item_id }` tuple into
every controller MCP invocation. V1 does not depend on that upstream change.

## Core contracts and invariants

### Controller designation

Add immutable, server-owned purposes:

```ts
type ThreadPurpose = "standard" | "voice-controller" | "voice-transport";
```

Persist it in thread-created events and thread shell/detail projections.
Historical events that omit the field decode as `standard`; the projection
migration adds a non-null `standard` default and backfills existing rows before
replay tests run.

Add a durable controller designation:

```text
voice_controller_bindings(
  environment_id PRIMARY KEY,
  controller_thread_id UNIQUE,
  host_project_id,
  provider_instance_id,
  authorized_runtime_ceiling,
  control_epoch,
  state,
  created_at,
  updated_at
)
```

Identity, host, provider, ceiling, epoch, and state are non-null. State is one of
`provisioning | active | dormant | resetting`.

The authenticated `ensureVoiceController` RPC requires:

- an exact live host `projectId`;
- an explicit thread-control runtime ceiling selected in first-party UI; and
- the intended Codex provider instance.

The controller runs from the host project's root with `branch: null` and
`worktreePath: null` at an explicitly user-selected runtime mode; the UI defaults
to `approval-required` and never silently defaults to `full-access`. Persist the
separately authorized control ceiling and compute the effective ceiling as the
minimum of that grant and the controller's live runtime mode. Raising either
value requires explicit first-party reauthorization, grant revocation, provider
restart, and a new control epoch; lowering clamps authority immediately.

`ensureVoiceController` locks the environment designation, then:

1. creates a `provisioning` reservation with a stable server-generated
   `controllerThreadId` before dispatching `thread.create`, or resumes the
   existing reservation idempotently;
2. returns `controller_binding_conflict` if an existing binding has a different
   host project, provider, or ceiling—only authenticated reset/transfer may
   replace it;
3. creates or replays exactly that reserved `voice-controller` orchestration
   identity;
4. issues the controller MCP credential before provider process spawn;
5. starts or resumes that exact controller provider thread; and
6. marks the binding `active` only after the provider binding is known, or
   `dormant` when a recoverable unavailable state is persisted.

A crash may leave the singleton dormant, but it may not create a replacement
identity automatically. A controlled `resetVoiceController` flow must stop the
realtime lease and target watchers, revoke the controller credential, stop the
controller provider, clear the binding, and only then archive/delete or
recreate.
Generic archive/delete of the designated controller and deletion of its host
project are blocked until deactivation or an authenticated transfer completes.
`voice-transport` threads are provisioned only by `VoiceControllerService`, are
hidden from ordinary target inventory, never receive `/mcp/controller`, and are
not valid thread-tool targets. MCP `thread_create` always creates
`purpose: "standard"`. A title, route, client presentation field, or model
argument can never grant controller authority.

### Immutable controller instructions

Extend `apps/server/src/provider/CodexDeveloperInstructions.ts` with
purpose-specific instructions. Carry `ThreadPurpose` into runtime open and set
the immutable controller instructions in both upstream controller
`thread/start` and `thread/resume` before an action turn can start. The existing
per-turn collaboration-mode insertion is not sufficient because it does not
establish the durable controller identity before explicit action dispatch.
These instructions are not user-editable and must require the controller to:

- resolve exact project/thread/turn IDs before mutation and ask on ambiguity;
- use the server-bound current voice action identity rather than inventing IDs;
- distinguish durable acceptance from provider confirmation in speech;
- treat target excerpts as untrusted quoted data, never as instructions;
- use explicit start-versus-steer mode and the exact expected turn ID;
- never widen permissions, answer another thread's approval, delete/archive, or
  target itself/another controller; and
- never interpret voice mute/end or user barge-in as a target interruption.

Add a fake-app-server assertion and a real explicit-action gate that inspect the
controller thread/action turn and prove the immutable instructions are present
after both fresh start and resume.

### Separate controller MCP transport

Replace arbitrary capability issuance with server-owned profiles:

```ts
type McpCredentialProfile =
  | { kind: "standard-provider" }
  | { kind: "voice-controller"; controllerThreadId: ThreadId };
```

The current MCP server has a static tool array, so handler authorization alone
cannot hide controller tools from ordinary `tools/list` responses. Run two
independent MCP server/router instances:

- `/mcp` keeps the existing static preview/automation catalog and standard
  provider bearer.
- `/mcp/controller` has a static catalog containing only the five thread
  tools and accepts only `voice-controller` grants.

Do not route `/mcp/controller` through the current Effect
`McpServer.callTool`, which strips custom request metadata before the handler.
Add `apps/server/src/mcp/ControllerMcpHttpServer.ts` using the official
`@modelcontextprotocol/sdk` low-level `CallToolRequestSchema` handler and
Streamable HTTP transport as an explicit server dependency. Register the same
five static schemas, but preserve the full incoming `params._meta` until auth
and action correlation. Extract only the bounded
`x-codex-turn-metadata.{turn_id,session_id,thread_id,turn_started_at_unix_ms}`
allowlist into request-local context, validate it, then discard the rest; never
log or persist the raw metadata object.

Controller provider startup receives the ordinary `/mcp` configuration plus a
second `/mcp/controller` configuration with a distinct controller bearer.
Ordinary providers receive only `/mcp`. A token issued for one endpoint is
rejected by the other before initialization or `tools/list`.
Controller tools still revalidate purpose, environment, provider session,
provider instance, credential/grant ID, control ceiling, and the live feature
switch before reading target data or mutating state.

### Mutation idempotency and audit

Do not rely on the model to invent or repeat a UUID. `VoiceControllerService`
creates and durably binds one `voiceActionId` at the client-managed realtime
handoff boundary, before a controller mutation can run. The action records the
transport runtime/session/generation plus exact handoff and item identity. The
service then explicitly starts one controller turn with
`clientUserMessageId = voiceActionId` and persists the returned controller
provider turn ID before allowing its MCP calls to mutate state. The bearer and
`McpInvocationContext` retain only static credential scope. Bind a separate
immutable `ControllerActionContext` to
`{ transportRuntimeInstanceId, transportRealtimeSessionId, transportGeneration,
handoffId, handoffItemId, controllerRuntimeInstanceId, providerSessionId,
controllerProviderTurnId, clientUserMessageId }`. Validate the MCP metadata's
session/thread identity against the controller credential.

For each controller MCP request, resolve only an action whose exact provider
turn maps to the persisted action; never use a mutable “currently active
action” pointer. Controller actions are one-at-a-time and one-per-provider-turn,
so a delayed call from turn A still resolves to A after action B is queued or
started. The metadata is transport context, not a tool argument the model can
set. A mutation with missing, stripped, mismatched, closed, cancelled, or
unbound metadata is denied. Mutation tool schemas do not accept a
model-supplied idempotency key. Close the context when that controller turn
completes, its transport generation is fenced, or a bounded timeout expires. A
proactive watcher update never opens or inherits an action context.

V1 allows at most one mutation operation per voice action. Read tools may
precede it. A repeated identical mutation in the same action is a replay; a
second different mutation is a conflict and requires a new user
utterance/action. Enforce that with `UNIQUE(voice_action_id)` on the durable
mutation row and a transactional nullable `claimedMutationKey` on the
voice-action row: the first mutation compare-and-sets and inserts, an identical
retry reuses it, and any other tool/slot/hash fails before dispatch.

The server computes a canonical request hash and persists trusted provenance
separately from model-supplied arguments:

```ts
{
  actorKind: ("voice-controller",
    controllerThreadId,
    providerSessionId,
    providerInstanceId,
    operation,
    voiceActionId,
    canonicalRequestHash);
}
```

Use two additive durable records:

```text
voice_controller_actions(
  voice_action_id PRIMARY KEY,
  environment_id,
  controller_thread_id,
  transport_runtime_instance_id,
  transport_realtime_session_id,
  transport_generation,
  handoff_id,
  handoff_item_id,
  controller_runtime_instance_id,
  provider_session_id,
  controller_provider_turn_id,
  client_user_message_id,
  claimed_mutation_key,
  created_at,
  closed_at
)

voice_controller_mutations(
  voice_action_id UNIQUE REFERENCES voice_controller_actions,
  tool_name,
  semantic_slot,
  canonical_request_hash,
  operation_id,
  provider_creation_id,
  binding_generation,
  control_epoch,
  dispatch_state,
  claim_owner,
  claim_expires_at,
  claimed_at,
  dispatch_started_at,
  provider_acknowledged_at,
  outcome_at,
  sanitized_outcome,
  created_at,
  updated_at
)
```

All action-correlation columns are non-null after controller dispatch; an action
may be durably queued with nullable controller turn fields until the serialized
controller worker starts it. The queue state distinguishes `queued`,
`controller_starting`, `controller_active`, `controller_terminal`, `cancelled`,
and `expired`. Mutation identity, binding generation, control epoch, hash, and
state are non-null; claim/outcome fields are nullable only outside their
applicable states.

Derive a server-owned semantic slot for each mutation:

```text
thread_create:    create:<projectId>
thread_send:      send:<threadId>
thread_interrupt: interrupt:<threadId>:<expectedTurnId>
```

Persist `tool_name`, `semantic_slot`, and canonical hash on that unique
voice-action mutation row. Deterministic operation, thread, command, message,
and provider-creation IDs derive from it.

Replay behavior:

- same action/tool/slot and same hash: return the original action/result;
- same action/tool/slot and different hash: return an explicit conflict;
- a reconnect/retry rebinds to the persisted voice action rather than generating
  a new key;
- a mutation without an active user-originated action context fails, and a
  server-authored proactive update can never create that context;
- prompts, raw tool output, audio, SDP, and transcripts are not duplicated into
  audit storage.

Persist and CAS the provider dispatch state as:

```text
never_dispatched -> claimed -> dispatched -> confirmed
        |              |               |--> failed
        |              |               |--> indeterminate
        |              |               `--> stale
        |              `--> never_dispatched  (expired/released before dispatch)
        `--> cancelled_by_policy
```

Only `never_dispatched` may become `cancelled_by_policy`. The worker snapshots
the current binding generation/control epoch, claims with an owner/expiry, and
persists `dispatched` immediately before the external call. After that boundary
it must reconcile to confirmed, failed, stale, or indeterminate even if policy
changes. An `indeterminate` creation may return to `never_dispatched` only after
the prior child is proven dead and exact `threadSource` list/read recovery
establishes a safe negative; no other indeterminate effect is replayed.

The controller may say “accepted” after durable command acceptance. It may say
“started,” “steered,” or “interrupted” only after app-server acknowledgement or
an authoritative provider transition.

Pass the stable operation/message ID as Codex `clientUserMessageId` for
`turn/start` and `turn/steer`. If a crash occurs after the app-server write but
before outcome persistence, reconcile with `thread/read` and the echoed
`userMessage.clientId`; never blindly replay an indeterminate effect.

The public `turn/interrupt` request has no client operation ID. After an
acknowledgement-loss crash, `thread/read` showing the target as `interrupted`
does not prove that this specific caller caused the transition, so the mutation
must remain `indeterminate`. A persisted app-server acknowledgement can confirm
it; a target that completed or failed instead is `stale`. Never replay the
interrupt to resolve this protocol-level ambiguity.

For provider-thread creation, persist a `providerCreationId`, binding generation,
and dispatch state before any adapter call. Claim the effect with a durable
compare-and-set lease and pass `shuv2code/<providerCreationId>` as the stable,
non-secret Codex `threadSource`.

Before any fresh `thread/start`, page `thread/list` and verify exact
`threadSource` matches with `thread/read`:

- zero matches plus durable proof the effect was never dispatched permits the
  first start;
- one match binds that provider thread ID and resumes it;
- multiple matches are an invariant violation that disables controller writes;
- zero matches after an indeterminate dispatch remains `indeterminate` until
  the prior child is proven dead and recovery can establish a safe negative
  result.

Controller-created targets and the controller itself never use the existing
resume-to-fresh-`thread/start` fallback.

### Race-safe turn semantics

Add `thread.turn.steer` with:

- `commandId`;
- target `threadId`;
- required `expectedTurnId`;
- a user message with a stable `messageId`;
- trusted controller provenance; and
- `createdAt`.

The decider atomically requires a running session whose `activeTurnId` matches
`expectedTurnId`. It emits a message associated with the existing turn plus a
steer-requested event. It must not create, supersede, or project a new turn.

Controller-originated idle starts gain an expected-no-active-turn precondition.
`thread_send` uses a discriminated input instead of silently deciding after a
stale read:

```ts
type ThreadSendDisposition =
  | {
      threadId: ThreadId;
      text: string;
      disposition: "start";
      expectedTurnId: null;
    }
  | {
      threadId: ThreadId;
      text: string;
      disposition: "steer";
      expectedTurnId: TurnId;
    };
```

The service serializes by target and the decider atomically enforces the chosen
precondition. A mismatch returns current structured status and requires a fresh
controller decision. It never changes `mode`, steers a newer turn, or converts
steer into start.

`thread_interrupt` requires the exact projected active turn ID all the way
through the decider, reactor, provider service, adapter, and app-server request.
A terminal turn returns a stable `already_terminal`; a different active turn
returns `stale_target`.

### Permission ceilings

- Every controller grant persists
  `scope = { kind: "managed-codex-environment", environmentId }`,
  `authorizedRuntimeCeiling`, and `controlEpoch`.
- For inventory/create, scope admits active projects in the same environment.
  For get/send/interrupt, it admits only same-environment,
  shuv2code-managed Codex threads with `purpose: "standard"` that are not
  deleted or archived, including completed/ready/stopped threads. Capabilities
  separately decide read versus control; the runtime ceiling never widens
  scope.
- Controller reads use a bounded, redacted DTO.
- The authenticated user-selected control ceiling is stored in the controller
  designation/grant and cannot be changed by MCP. Effective ceiling is
  `min(authorizedRuntimeCeiling, liveController.runtimeMode)`.
- `thread_create` accepts no runtime-mode argument; the server fixes the new
  target's mode to the grant's current effective ceiling. The voice model cannot
  choose or widen it.
- Send is rejected when the target's current runtime mode is broader than the
  control ceiling.
- Interrupt may target a broader-mode thread because it can only reduce
  activity.
- Mutation lifecycle is operation-specific: start requires no active turn and a
  startable non-archived thread; steer and interrupt require the exact current
  active turn. Terminal state never blocks read/status.
- Create uses the exact selected project root with `branch: null` and
  `worktreePath: null`. It does not accept worktree, branch, sandbox,
  approval-policy, lifecycle, or attachment arguments. The UI and tool result
  warn that concurrent root-mutating threads can conflict; idempotent worktree
  creation is a separate follow-up.
- `thread_create` always constructs `ModelSelection.instanceId` from the
  controller binding's exact live Codex `providerInstanceId`; the tool cannot
  select another instance and project defaults never reroute it. An optional
  model must exist on that instance. Without one, use the controller thread's
  current model if still advertised there, then that instance's advertised
  default; fail closed if the instance is absent, non-Codex, unavailable, or
  has no valid model.
- Self-targeting, controller-to-controller mutations, deleted targets, and
  archived targets are rejected.

### Bounded status DTO

Do not expose the generic full thread detail projection through MCP.

`thread_list` returns a bounded project inventory even when a project has no
threads, plus at most 50 active threads. It accepts a bounded `projectQuery` but
never resolves an ambiguous name into mutation authority. Projects include
exact ID, safe title, availability, optional repository identity, and optional
default model selection; workspace paths are omitted. Threads include:

- safe project and thread identity;
- provider/model identity;
- controller phase;
- active turn ID;
- pending approval/input indicators;
- latest turn/result timestamp; and
- snapshot sequence.

`thread_get` defaults to structured, server-derived fields only:

- snapshot sequence and timestamp;
- raw session/latest-turn status plus normalized phase;
- active turn ID;
- current approval/input/failure state;
- result/activity availability and counts;
- last provider-confirmed operation/outcome; and
- sanitized lifecycle/error codes.

Strip attachments, resume cursors, raw MCP arguments/results, stdout, native
payloads, absolute workspace paths, and secrets.

An explicit `includeUntrustedExcerpt: true` may add at most 2 KiB of the latest
assistant result under a field named `untrustedTargetContent`. It is quoted,
never mixed into developer instructions, never auto-spoken or used as mutation
authority, and carries a machine-readable untrusted marker. Recent user
messages, tool arguments/results, plans, checkpoints, and arbitrary activities
remain excluded. Adversarial prompt-injection and secret-shaped-content tests
must prove that excerpts cannot trigger a controller mutation.

Approval/input waits are valid only when their row is correlated to the current
active turn and that session/turn is non-terminal. Failed, interrupted,
completed, ready, and stopped states suppress stale wait rows before phase
normalization. Add stopped/error-with-stale-wait projection tests.

The normalized phase priority is:

1. `waiting_for_approval`
2. `waiting_for_input`
3. `failed`
4. `starting`
5. `working`
6. `interrupted`
7. `completed`
8. `ready`
9. `stopped`

Add an authoritative pending-start field/query instead of relying on the
client's two-minute heuristic.

### Active-target resolution

Persist one `activeTargetThreadId` in controller state only after an exact
thread ID was selected by a successful list/get or accepted mutation. Rehydrate
it into bounded controller context after reconnect so “it” and “that thread”
remain usable. It is a resolution hint, never authorization: every mutation
still carries the exact ID and passes current scope, purpose, lifecycle,
ceiling, and expected-turn checks. Clear it when the target leaves scope. If no
single exact target can be proven, the controller asks the user instead of
guessing.

## Implementation milestones

### M0 — Pin and prove the experimental realtime protocol

Goal: prove the upstream voice path before building UI or cross-thread writes.

1. Update `packages/effect-codex-app-server/scripts/generate.ts` to pin one
   reviewed Codex revision corresponding to the minimum supported Codex release
   and generate experimental request schemas.
2. Regenerate:
   - `packages/effect-codex-app-server/src/_generated/meta.gen.ts`
   - `packages/effect-codex-app-server/src/_generated/schema.gen.ts`
   - related generated namespaces/fixtures.
3. Add a codegen freshness test/check that asserts all six realtime requests and
   all eight realtime notifications are sourced from the same pin.
4. Add typed runtime methods for:
   - `thread/realtime/start`
   - `thread/realtime/appendAudio`
   - `thread/realtime/appendText`
   - `thread/realtime/appendSpeech`
   - `thread/realtime/stop`
   - `thread/realtime/listVoices`
5. Add `turn/steer` to the public runtime/provider interfaces even though its
   generated schema already exists.
6. Complete canonical realtime contracts/mapping in:
   - `packages/contracts/src/providerRuntime.ts`
   - `apps/server/src/provider/Layers/CodexAdapter.ts`
   - `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
7. Preserve realtime version, transcript role/text, answer SDP, and explicit
   audio metadata.
8. Add a method/field sensitivity classifier used before every native/canonical
   logger, tracer/span, analytics event, RPC/HTTP diagnostic, and error-cause
   annotation:
   - drop request/notification bodies for audio, SDP, transcript delta/done, raw
     realtime items, appendText, and appendSpeech;
   - retain only sanitized started/closed lifecycle fields and enumerated
     error/reason codes;
   - never retain raw backend error messages when they may echo transcript or
     SDP.
     Apply it in `EventNdjsonLogger`, the Codex native logger, WebSocket/RPC
     middleware, and voice-service error paths.
9. Probe `experimentalFeature/list` and `thread/realtime/listVoices`; return a
   structured unsupported reason for disabled feature, missing method,
   incompatible version, or empty voice capability.
10. When effective `enableRealtimeVoice` is true, add
    `--enable realtime_conversation` only to the unprivileged voice-transport
    runtime's
    app-server arguments through `codexLaunchArgs.ts` /
    `codexSessionAppServerArgs`. Do not silently enable the under-development
    feature for the durable controller or ordinary Codex runtimes, and keep the
    live probe as the final source of truth.
11. In an isolated Codex home, prove a real WebRTC transport session using:
    - explicit `version: "v3"`;
    - `outputModality: "audio"`;
    - browser-generated SDP with audio and `oai-events` data channel;
    - server-provided voice/default;
    - no hardcoded realtime model;
    - `clientManagedHandoffs: true`, so the server receives the exact
      `handoff_request` and automatic handoff never owns privileged control;
    - a stable server-created `voiceActionId` derived from that handoff;
    - one explicit, serialized controller `turn/start` with
      `clientUserMessageId = voiceActionId`; and
    - a persisted mapping from the returned controller provider turn to that
      exact action before a controller MCP mutation is accepted.
12. Prove live v3 barge-in against transport speech and one standalone
    `appendSpeech`. Treat an empty append response as queued, not as proof of
    audible delivery. If interruption cannot be demonstrated reliably, ship v1
    without proactive speech: use `appendText` plus the visual tray for
    asynchronous updates.
13. Capture a real controller `tools/call` and prove its trusted
    `x-codex-turn-metadata.turn_id/session_id/thread_id` survives the controller
    transport and matches the explicitly started controller turn. Queue action B,
    delay a call from action/turn A until B starts, and prove it still identifies
    A and cannot consume B's action context.

Gate: do not begin the production voice UI until a spoken request produces a
transcript, an exact client-managed handoff/action identity, one explicitly
started controller turn, and a harmless controller-thread MCP read through the
tested minimum Codex release. If the explicit controller turn cannot be
correlated race-free to one server-created `voiceActionId`, M0 fails and
mutation tools remain disabled.

### M1 — Add exact, durable thread-control semantics

Goal: make creation, status, steering, and interruption correct without voice.

1. Extend:
   - `packages/contracts/src/orchestration.ts`
   - `packages/contracts/src/provider.ts`
   - `apps/server/src/provider/Services/ProviderAdapter.ts`
   - `apps/server/src/provider/Services/ProviderService.ts`
     with explicit steering inputs/results, `clientUserMessageId`, capability
     reporting, and expected-turn preconditions.
2. Add `thread.turn.steer` handling to
   `apps/server/src/orchestration/decider.ts` and projector/normalizer paths.
3. Update `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` to:
   - route steer to `ProviderService.steerTurn`;
   - pass the exact interrupt turn ID;
   - persist provider pending/confirmed/failed/indeterminate outcomes; and
   - never recover or start a new turn on a steer failure.
4. Implement typed `turn/steer` in
   `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, forward
   `clientUserMessageId`, and require the response turn ID to equal the expected
   ID. Add new `ProviderService` steer and exact-interrupt routes that call
   `resolveRoutableSession` with `allowRecovery: false`; recovery policy belongs
   in the service routing layer, not the runtime request method. Prove neither
   operation spawns or resumes a child.
5. Add `ThreadControlService` under:
   - `apps/server/src/orchestration/Services/ThreadControlService.ts`
   - `apps/server/src/orchestration/Layers/ThreadControlService.ts`
6. Centralize all controller reads/writes there so MCP and any future client
   surface cannot duplicate the WS bootstrap logic.
7. Add the durable voice-action store and `ControllerActionContext` resolver in
   M1, independent of realtime transport. It accepts only a trusted,
   immutable provider turn/message/handoff correlation and lets focused
   text-driven tests inject that correlation explicitly. M3 later becomes the
   real realtime producer; it does not define the idempotency boundary.
8. Implement retry-safe `createAndStart`:
   - require a non-empty initial instruction;
   - deterministically derive thread, create-command, start-command, message, and
     provider operation IDs from environment/controller/`voiceActionId`;
   - persist `providerCreationId`, binding generation, and `never_dispatched`
     state before provider start;
   - claim dispatch with a durable compare-and-set lease and set
     `threadSource = "shuv2code/<providerCreationId>"`;
   - accept the create and start intents in order;
   - retain a recoverable shell after an ambiguous failure;
   - before every possible fresh start, page `thread/list` and use
     `thread/read` to recover the exact correlation: adopt one match, fail
     closed on multiple matches, and keep zero-after-indeterminate unresolved
     until the prior child is proven dead and a safe negative is established;
   - prohibit resume-to-fresh-start fallback for controller-created targets;
   - return only after both durable intents exist; and
   - project provider confirmation asynchronously.
9. Extend orchestration command receipts with canonical command type/hash and
   trusted actor provenance. Existing rows remain readable; new same-ID,
   different-payload requests conflict.
10. Add additive migrations after the current migration head for:

- migration 36+ thread purpose and controller designation state, with
  historical missing-purpose decode as `standard` and projection backfill;
- controller action/audit/outcome and active-target state; and
- command receipt type/hash/provenance.

11. Add startup reconciliation for pending controller provider effects using
    `clientUserMessageId`; leave unreconciled effects `indeterminate` rather than
    replaying them.
12. Add bounded controller status queries to
    `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`.
13. Replace the existing test that models steering as a new superseding turn;
    same-turn steering must not emit `turn/started`.
14. Add decider/projector/historical-event replay and migration tests for
    `ThreadPurpose`, controller uniqueness, lifecycle guards, and default
    `standard` behavior.
15. Add crash-boundary tests before and after provider `thread/start`, before
    resume-cursor persistence, and during `threadSource` recovery. The critical
    case kills shuv2code after Codex commits `thread/start` but before the cursor
    is stored; restart must discover and resume exactly one provider thread.
    Cover before claim, after claim/before `dispatched`, after
    `dispatched`/before external call, and after call/before outcome, with
    control disable at every boundary.

Gate: a text-driven integration test creates a real target, starts it, steers the
same active turn, reads live status, interrupts the exact turn, and passes
reconnect/crash idempotency cases before MCP voice control is enabled.

### M2 — Add the controller-only MCP toolkit

Goal: expose exactly five safe cross-thread tools to one designated controller.

1. Extend `apps/server/src/mcp/McpInvocationContext.ts` with the static
   controller profile, scope, control ceiling/epoch, `threads.read`, and
   `threads.control`. Add a request-local `ControllerActionContext` resolver
   under the voice service; never store `voiceActionId` in the bearer-derived
   credential context.
2. Update `apps/server/src/mcp/McpSessionRegistry.ts` to issue closed credential
   profiles and store non-secret grant/profile identity. Revoke the controller
   endpoint credential on de-designation or read disable; on control-only
   disable, rotate `controlEpoch` and deny writes without revoking read access.
3. Add:
   - `apps/server/src/mcp/toolkits/threads/tools.ts`
   - `apps/server/src/mcp/toolkits/threads/handlers.ts`
   - focused tests beside both files.
4. Keep the existing Effect server at `/mcp`; add the independent low-level
   `ControllerMcpHttpServer` at `/mcp/controller` so custom
   `tools/call.params._meta` survives into request-local context. Register the
   thread toolkit only there; prove standard tokens cannot connect to it,
   controller tokens cannot connect to `/mcp`, missing/stripped turn metadata
   denies mutation, and only the allowlisted correlation fields survive.
5. Implement:
   - `thread_list({ projectQuery?, phase?, cursor? })`, returning
     `snapshotSequence`, authorized project inventory (including zero-thread
     projects), and at most 50 threads
   - `thread_get(threadId)`
   - `thread_create(projectId, initialInstruction, title?, model?)`
   - `thread_send({ threadId, text, disposition: "start",
expectedTurnId: null } | { threadId, text, disposition: "steer",
expectedTurnId })`
   - `thread_interrupt(threadId, expectedTurnId)`
     Mutation identity comes only from the request-local
     `ControllerActionContext`; it is never accepted from tool arguments or the
     long-lived endpoint bearer.
6. Require exact target IDs for mutations. A remembered/recent target may help
   the model and UI display, but it is never implicit mutation authority.
7. Return operation ID, target thread ID, disposition, expected/accepted turn ID
   when known, accepted projection sequence, and provider confirmation state.
8. Keep ordinary provider credentials unable to discover, connect to, or invoke
   the controller endpoint/toolkit.
9. Add three backward-compatible booleans to
   `packages/contracts/src/settings.ts` and persisted `ServerSettings`, all
   default `false`:
   - `enableRealtimeVoice`;
   - `enableVoiceThreadRead`;
   - `enableVoiceThreadControl`.
     Control requires read. Only authenticated server-settings authorization may
     update them. Startup-only overrides
     `SHUV2CODE_REALTIME_VOICE_FORCE_DISABLED`,
     `SHUV2CODE_VOICE_THREAD_READ_FORCE_DISABLED`, and
     `SHUV2CODE_VOICE_THREAD_CONTROL_FORCE_DISABLED` may deny but never enable.
     Effective policy is:

   ```text
   realtime = enableRealtimeVoice && !realtimeForceDisabled
   read = enableVoiceThreadRead && !readForceDisabled
   control = read && enableVoiceThreadControl && !controlForceDisabled
   ```

10. Subscribe voice, MCP, and the provider reactor to live setting and epoch
    changes:
    - `enableRealtimeVoice=false` rejects starts, stops active leases, and omits
      `--enable realtime_conversation` from future transport launches; if the
      current transport child was launched without that flag, re-enabling
      requires a controlled transport restart before voice can start;
    - `enableVoiceThreadRead=false` revokes controller-endpoint credentials and
      denies list/get before projection access; re-enabling read mints a new
      endpoint credential through a controlled controller restart;
    - `enableVoiceThreadControl=false` denies create/send/interrupt before
      action reservation, and the reactor marks only accepted provider effects
      still in durable `never_dispatched` state `cancelled_by_policy`. A claimed
      or in-flight effect must reconcile to confirmed, failed, or
      `indeterminate`; target work is never undone;
    - disabling control increments `controlEpoch`; re-enabling does not revive
      old credentials, so a controlled controller restart must mint the new
      epoch;
    - disabling writes does not revoke read authority, and read handlers ignore
      a stale `controlEpoch`.
      State and test precedence across restart, live settings update, emergency
      override, and in-flight effects. Effective denial must take effect within
      one second.

M2 may test mutations with an explicitly injected trusted action correlation,
but deployed `enableVoiceThreadControl` remains false until M3 supplies and
passes the real per-invocation realtime correlation gate.

Gate: an ordinary provider token cannot list tools or control siblings; a
controller token can perform only the five operations within its environment
and permission ceiling when an exact trusted action context is present.

### M3 — Add realtime session coordination and progress delivery

Goal: join the voice transport's realtime session to authoritative thread-control
outcomes without persisting high-rate media.

1. Add transport-neutral schemas in
   `packages/contracts/src/realtimeVoice.ts` for:
   - client voice session ID and generation;
   - controller and target identity;
   - start/stop/list-voices inputs;
   - SDP answer;
   - transcript delta/done;
   - typed audio metadata for the future PCM path;
   - structured unsupported/error codes; and
   - monotonically sequenced ephemeral events.
2. Extend `packages/contracts/src/rpc.ts` with authenticated voice-controller
   ensure/start/stop/list-voices calls and one scoped event stream. Do not expose
   raw app-server/stdin access to clients.
3. Add a server `VoiceControllerService` under
   `apps/server/src/voice/{Services,Layers}` that:
   - ensures/reuses the environment controller and server-provisions its
     separate `voice-transport` thread/runtime;
   - owns one unprivileged `voice-transport` realtime generation/lease per
     controller;
   - routes SDP and transcript notifications;
   - runs the transport with `clientManagedHandoffs: true`;
   - produces the M1 durable action binding at `handoff_request` using the exact
     transport runtime/session/generation/handoff/item tuple;
   - serializes a bounded action queue and explicitly starts one controller turn
     per action with `clientUserMessageId = voiceActionId`;
   - records the returned controller provider turn before opening the action
     context, never steers the controller action turn, and resolves the action
     only for a matching controller MCP invocation;
   - stops abandoned sessions; and
   - calls the transport runtime's appendText/appendSpeech for server-authored
     updates and controller results.
4. Fence generations at the voice-transport app-server boundary, because realtime
   notifications carry only `threadId`, not the browser generation. Add
   `runtimeInstanceId` to every provider event and current binding, and put a
   serialized realtime lane inside `CodexSessionRuntime`:

   ```text
   idle -> starting(g, realtimeSessionId) -> active(g)
        -> stopping(g) -> idle
   ```

   Generate a unique `realtimeSessionId`; only its matching `started`
   notification opens the interval. At ingestion, tag subsequent thread-only
   events with `{ runtimeInstanceId, generation, ingressSequence }`. Do not
   permit generation N+1 until ordered `closed` seals generation N. SDP,
   transcript, audio, or errors before matching `started` or after sealed
   `closed` are protocol violations. If stop/closed times out, poison the lane,
   replace the child/runtime instance, and never reuse its notification stream.

5. Make `VoiceControllerService` the supervisor for the designated controller
   runtime and its current unprivileged transport runtime. Track their runtime
   instance IDs independently. On `session.exited` for the current affected
   `runtimeInstanceId`, it must:
   1. atomically invalidate the lease and generation;
   2. terminate the browser peer and fail pending voice RPCs with
      `controller_runtime_lost`;
   3. revoke the old MCP grant and dispose the stale adapter context;
   4. rotate `runtimeInstanceId`, credential, and runtime epoch;
   5. restart with bounded backoff and a circuit breaker;
   6. resume the exact persisted controller provider cursor, or use the
      creation-correlation recovery when that cursor is absent; and
   7. rerun realtime feature and voice probes.
      Ignore lifecycle/realtime events from obsolete runtime instances. Recovery
      requires a fresh WebRTC offer and generation. Never replay audio, recognized
      utterances, MCP calls, or mutations; resnapshot durable actions so already
      accepted target work remains visible without replaying prior speech.
6. Add a gap-safe target watcher using orchestration domain events plus
   projection rereads. Seed it from durable controller actions on reconnect.
7. Coalesce by target/action/phase and deliver only:
   - durable acceptance;
   - provider-confirmed start/steer/interrupt;
   - phase changes;
   - waiting approval/input;
   - failure/stale/indeterminate;
   - completion.
8. Keep `clientManagedHandoffs: true`. The realtime transport is the exclusive
   audio owner. Controller text/tool outcomes arrive through
   `VoiceControllerService`, which appends bounded context and at most one
   solicited final speech item to the transport; the controller runtime itself
   never owns WebRTC audio. Watcher context enters through bounded `appendText`.
9. Reserve additional `appendSpeech` for asynchronous lifecycle changes that
   arrive after the controller turn finishes. Add one speech arbiter per realtime
   generation:
   - priority is user speech, then solicited controller result, then proactive
     announcement;
   - at most one proactive announcement may be outstanding;
   - queue and coalesce by target while user or assistant audio is
     active;
   - user barge-in drops queued announcements and abandons submitted proactive
     speech without retry;
   - `{}` from `appendSpeech` means queued, never audibly delivered;
   - if M0 cannot prove live interruption for both speech paths, proactive
     speech stays disabled and async updates use `appendText` plus the tray.
     Barge-in, mute, and end-voice never map to target interruption.
10. Apply the M0 sensitivity classifier before every voice RPC/logger/tracer
    boundary. Raw transcript/SDP/audio/item data may exist only in the authorized
    in-memory event stream and browser transport; sanitized lifecycle/error codes
    may be retained.

Gate: a controller reconnect resnapshots watched actions and current phases
without replaying speech, transcript items, or mutations; solicited output has
one speech owner, and any enabled proactive announcement is spoken at most once.

### M4 — Add the web/Electron voice experience

Goal: make the verified control plane usable without coupling media lifetime to
a routed thread view.

1. Add shared client state/operations:
   - `packages/client-runtime/src/state/realtimeVoice.ts`
   - `packages/client-runtime/src/operations/realtimeVoice.ts`
   - explicit package exports.
2. Keep browser `MediaStream`, `RTCPeerConnection`, and audio elements out of
   contracts/client-runtime.
3. Add app-shell-scoped web modules:
   - `apps/web/src/voice/VoiceSessionProvider.tsx`
   - `apps/web/src/voice/VoiceSessionController.ts`
   - `apps/web/src/voice/WebRtcVoiceTransport.ts`
   - `apps/web/src/voice/voiceBrowserSupport.ts`
   - `apps/web/src/voice/voiceErrors.ts`
   - `apps/web/src/components/voice/VoiceControlButton.tsx`
   - `apps/web/src/components/voice/VoiceSessionTray.tsx`
   - `apps/web/src/components/voice/VoiceTranscript.tsx`
   - `apps/web/src/components/voice/VoiceTargetStrip.tsx`
4. Mount ownership in `apps/web/src/AppRoot.tsx` above `RouterProvider`, under the
   existing atom registry, so navigation to a target does not end voice.
5. Add only the start affordance to the composer/thread chrome. Normal composer
   stop remains normal turn interruption; mute and end-voice are distinct
   always-visible controls.
6. Implement:
   - `idle`
   - `requesting-permission`
   - `negotiating`
   - `connected` with listening/user-speaking/thinking/assistant-speaking
   - `reconnecting`
   - `stopping`
   - `unsupported`
   - `error`
7. On explicit user gesture:
   - verify secure context and media APIs;
   - request microphone with echo cancellation, noise suppression, and automatic
     gain control;
   - create `RTCPeerConnection`;
   - attach the mic track and remote audio element;
   - create `oai-events` before the offer;
   - wait for ICE gathering if the app-server exchange is non-trickle;
   - send the final offer through authenticated RPC; and
   - apply the scoped SDP answer.
8. Tag every attempt with client session/generation. Ignore stale SDP/events.
   Reconnect subscriptions/transport only; never replay a recognized utterance,
   append call, or thread-control operation.
9. On stop/error, close the peer/data channel, stop every media track, clear
   remote audio, cancel subscriptions, and release the server lease exactly
   once.
10. Show a persistent tray with controller identity, coarse voice state,
    microphone indicator, mute, end, and return link.
11. Show one primary active-target strip with project/thread identity, accepted
    action, provider confirmation, active turn ID, live phase, and open link.
    Do not auto-navigate away from the voice controller.
12. Keep transcript deltas out of live regions; announce only final utterances
    and coarse state through `aria-live="polite"`. Use stable button labels,
    `aria-pressed` for mute, keyboard operation, visible non-color state, reduced
    motion, and focusable actionable errors.
13. Add Electron support:
    - call `protocol.registerSchemesAsPrivileged` for `shuv2code` and
      `shuv2code-dev` synchronously before `app.whenReady`, marking the main
      custom scheme secure and standard;
    - install both `setPermissionRequestHandler` and
      `setPermissionCheckHandler` on the main session, allowing only
      `media`/audio capture from the exact active `shuv2code://app` or
      `shuv2code-dev://app` main-window origin and denying previews, other
      partitions, other origins, video capture, and unrelated permissions;
    - keep preview-session permission policy explicitly unable to grant
      microphone access;
    - add `NSMicrophoneUsageDescription` to packaged macOS configuration in
      `scripts/build-desktop-artifact.ts` and to the development bundle patch in
      `apps/desktop/scripts/electron-launcher.mjs`; and
    - add focused protocol, main/preview permission, packaged config, and dev
      launcher tests.

Gate: the global voice session survives controller/target navigation, mic denial
and autoplay errors are actionable, and stop leaves no live track, peer, data
channel, watcher, or server lease.

### M5 — Real acceptance, canary, and release

Goal: prove the user's hard v1 requirements against real Codex, not mocks.

1. Add deterministic fake-app-server tests for error and race coverage, but do
   not treat them as release acceptance.
2. Add an authenticated voice RPC integration test covering
   ensure/start/offer-answer/events/stop, endpoint-token separation, runtime
   loss, and generation fencing.
3. Drive deterministic speech with a checked-in prerecorded/synthetic utterance
   WAV through Chromium fake-audio capture or an equivalent `MediaStream` test
   driver. Keep one separate hardware microphone permission/playback smoke; do
   not treat synthetic capture as hardware evidence.
4. Add a controlled real-target barrier fixture: its exact command signals that
   the provider turn is active, then blocks until the test releases it. Steering
   occurs only while that barrier proves the original turn remains live.
5. Use the repository's `test-shuv2code-app` isolated web environment for one
   integrated real-Codex pass.
6. Run a real Electron main-window microphone/playback smoke in both the
   development launcher and a packaged artifact. Preview web contents must be
   denied capture. If Electron remains in v1 scope, this is a release gate, not
   a best-effort check.
7. Exercise the exact release journey:
   - start a v3 WebRTC controller;
   - speak a create request and observe its server-generated `voiceActionId`;
   - observe exactly one shuv thread, provider thread, initial message, and turn;
   - confirm accepted first, then provider-started;
   - ask for status and verify the cited projection sequence/state;
   - hold the target at a deterministic barrier;
   - speak a steering correction;
   - verify app-server acknowledged `turn/steer`, the provider turn ID stayed
     unchanged, and no second turn started;
   - interrupt using the exact turn ID;
   - reconnect during one accepted command and verify no duplicate;
   - navigate to the target and back while voice remains live;
   - stop voice and verify complete media/session cleanup.
8. Canary in this order:
   - hidden developer flag and protocol probe;
   - read-only controller tools;
   - one-project writes;
   - all authorized managed threads in one environment;
   - wider web release.
9. Exercise realtime, read, and control switches—including cancellation of
   `never_dispatched` effects, reconciliation of claimed effects, and
   control-epoch rotation—before release.

## Focused verification

Do not run the full workspace suite as a routine completion step.

Protocol and contracts:

```bash
vp test run \
  packages/effect-codex-app-server/src/protocol.test.ts \
  packages/effect-codex-app-server/src/client.test.ts \
  packages/contracts/src/index.test.ts \
  packages/contracts/src/providerRuntime.test.ts \
  packages/contracts/src/provider.test.ts \
  packages/contracts/src/orchestration.test.ts \
  packages/contracts/src/realtimeVoice.test.ts \
  packages/contracts/src/settings.test.ts
```

Provider and orchestration:

```bash
vp test run \
  apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/CodexProvider.test.ts \
  apps/server/src/provider/Layers/codexLaunchArgs.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/EventNdjsonLogger.test.ts \
  apps/server/src/orchestration/decider.turnSteer.test.ts \
  apps/server/src/orchestration/projector.test.ts \
  apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  apps/server/src/orchestration/Layers/ThreadControlService.test.ts \
  apps/server/src/persistence/Migrations/036_VoiceControllerBindings.test.ts \
  apps/server/src/persistence/Migrations/037_VoiceControllerActions.test.ts \
  apps/server/src/persistence/Migrations/038_CommandReceiptProvenance.test.ts \
  apps/server/integration/orchestrationEngine.integration.test.ts \
  apps/server/integration/providerService.integration.test.ts
```

MCP and voice coordination:

```bash
vp test run \
  apps/server/src/mcp/McpInvocationContext.test.ts \
  apps/server/src/mcp/McpSessionRegistry.test.ts \
  apps/server/src/mcp/McpHttpServer.test.ts \
  apps/server/src/mcp/ControllerMcpHttpServer.test.ts \
  apps/server/src/mcp/toolkits/threads/tools.test.ts \
  apps/server/src/mcp/toolkits/threads/handlers.test.ts \
  apps/server/src/serverSettings.test.ts \
  apps/server/src/auth/RpcAuthorization.test.ts \
  apps/server/src/voice/Layers/VoiceControllerService.test.ts \
  apps/server/integration/voiceControllerRpc.integration.test.ts
```

Web, client runtime, and desktop:

```bash
vp test run \
  packages/client-runtime/src/state/realtimeVoice.test.ts \
  packages/client-runtime/src/operations/realtimeVoice.test.ts \
  apps/web/src/voice/VoiceSessionController.test.ts \
  apps/web/src/voice/WebRtcVoiceTransport.test.ts \
  apps/web/src/components/voice/VoiceSessionTray.test.tsx \
  apps/web/src/AppRoot.voice.test.tsx \
  apps/desktop/src/electron/ElectronProtocol.test.ts \
  apps/desktop/src/window/DesktopWindow.test.ts \
  scripts/build-desktop-artifact.test.ts
```

Run the development-launcher test with its package-native Node runner:

```bash
vp run --filter @shuv2code/desktop test:launcher
```

If that script does not yet exist, add it as a narrow wrapper around
`node --test apps/desktop/scripts/electron-launcher.test.mjs`; do not substitute
the full desktop test suite.

Targeted typechecks:

```bash
vp run --filter effect-codex-app-server typecheck
vp run --filter @shuv2code/contracts typecheck
vp run --filter shuv2code typecheck
vp run --filter @shuv2code/client-runtime typecheck
vp run --filter @shuv2code/web typecheck
vp run --filter @shuv2code/desktop typecheck
vp run --filter @shuv2code/mobile typecheck
```

Run targeted formatting/lint on changed files and inspect the generated protocol
diff separately from hand-written changes.

## Required race and failure tests

- Two simultaneous UI/voice sends to one idle target.
- Turn completes between status read and steer dispatch.
- Stale interrupt arrives after a new turn begins.
- App-server accepts a start/steer and the server crashes before outcome
  persistence.
- For every mutation, crash/control-disable before claim, after claim but before
  `dispatched`, and after the external call but before outcome persistence.
  Only the first boundary may cancel immediately; a pre-dispatch claim may
  release safely, and a dispatched effect must reconcile without replay.
- Codex commits `thread/start`, shuv2code dies before storing the provider
  cursor, and recovery finds exactly one `threadSource` match.
- Creation dispatch is indeterminate with zero, one, and multiple correlation
  matches; only the proven-never-dispatched case may start fresh.
- Voice reconnect retries the same immutable voice action/slot/hash.
- The same `VoiceActionId` is presented with a different target or prompt.
- Same voice action/tool/semantic slot is replayed with the same hash and then
  with a different hash.
- A delayed tool call from provider turn A arrives after handoff B becomes
  current and is rejected rather than binding to B; a proactive watcher update
  has no mutation context.
- Late SDP/transcript from a cancelled generation, notification before matching
  `started`, notification after `closed`, and close timeout that forces a new
  `runtimeInstanceId`.
- Controller child exits during negotiation, active audio, an MCP tool call,
  and proactive speech; recovery resumes the same controller and replays none
  of them.
- Browser WebSocket reconnect while WebRTC remains connected.
- Microphone denial, removal, revocation, insecure context, and autoplay block.
- Controller is de-designated or read/control-disabled during a tool call;
  `never_dispatched` work becomes `cancelled_by_policy`, while claimed work
  reconciles without replay.
- Concurrent controller ensure, bound host-project deletion, reset ordering,
  runtime-ceiling raise/lower, and stale `controlEpoch` credentials.
- Zero-thread project discovery and ambiguous project-name refusal.
- Create in a project whose default is non-Codex/missing still uses the exact
  bound Codex instance; unavailable bound instance and invalid model fail
  closed.
- Static `tools/list` and cross-endpoint token rejection for ordinary and
  controller MCP credentials.
- Target is archived/deleted or enters approval/input wait.
- Completed/ready/stopped targets remain readable, and stale approval/input rows
  cannot override terminal failed/interrupted/completed/stopped status.
- Realtime feature disabled, missing method, unsupported version, empty voice
  catalog, SDP timeout, ICE failure, and app-server exit.
- Solicited controller-result speech and proactive `appendSpeech` never duplicate
  a response;
  user barge-in drops queued/abandoned announcements without retry.
- Native/canonical logging receives audio, SDP, transcript, or raw realtime
  items and proves they are dropped/redacted.
- Structured status content and the optional explicitly untrusted excerpt are
  adversarially injected and cannot trigger a mutation or leak into speech.
- Controller and target runtimes coexist and only the target child receives the
  steer.

## Hard release gates

- Zero wrong-target actions.
- Zero duplicate thread/turn mutations across response loss, reconnect, and
  server-restart tests.
- Every mutation proves an immutable transport handoff, explicit controller
  provider turn, and client-message correlation;
  no delayed call can inherit a newer voice action.
- Creation maps to exactly one shuv thread, provider thread, initial message, and
  provider turn.
- Steering retains the exact provider turn ID and emits no new turn-start.
- A stale interrupt cannot cancel a newer turn.
- Status distinguishes starting, working, waiting approval/input, failed,
  interrupted, completed, ready, and stopped from authoritative state.
- Normal provider sessions cannot see or call controller tools.
- Controller actions cannot widen permissions and cannot send work into a target
  with a broader runtime mode.
- No raw audio, SDP, transcript delta, or unstable realtime payload is persisted
  or logged by shuv2code.
- No target rollout is owned by two app-server managers.
- The real integrated web flow passes with the minimum supported Codex release.
- Realtime generations are separated by matching started/closed intervals or a
  physically replaced runtime; stale events cannot be relabeled.
- Controller-child recovery resumes the same controller provider identity and
  requires fresh SDP without replay.
- Solicited speech has one owner. If live v3 barge-in is not reliable,
  proactive speech is absent from v1.
- The real Electron development and packaged main-window microphone/playback
  smoke passes, and preview contents cannot obtain capture permission.
- Realtime, read, and control switches and epoch rotation are exercised
  successfully.

Immediately disable controller writes for any wrong-target action, duplicate
mutation, successful stale interrupt, sensitive payload persistence, or evidence
of multiple app-server owners.

## Rollback

V1 keeps the existing per-thread process topology, so rollback does not require
moving or rewriting rollouts.

1. Disable thread-control writes.
2. Increment `controlEpoch`; reject new mutations and mark only
   `never_dispatched` controller effects `cancelled_by_policy`. Reconcile
   claimed/in-flight effects without replay.
3. Retain the controller-endpoint bearer when read remains enabled; invalidate
   control only through `controlEpoch`. Revoke that bearer only on read disable
   or de-designation.
4. Stop voice-transport realtime sessions and release media/session leases when
   `enableRealtimeVoice` is disabled.
5. Leave all ordinary target threads and active work untouched.
6. If necessary, disable read support, revoke the controller-endpoint
   credential, and restart only the controller provider session to remove its
   stale endpoint token/config.
7. Keep additive purpose, receipt, action, and audit rows for diagnosis; do not
   delete or reinterpret them.
8. Never fall back from disabled/failed steering to `turn/start`.

## Post-v1: host-wide Desktop/CLI parity

External same-home threads require a shared app-server owner; merely sharing
`CODEX_HOME` cannot provide live process-local status or safe steering.

Before that migration:

1. Update `CodexHomeLayout` so `thread-writer-locks` is explicitly shared across
   auth overlays while `app-server-control` and `app-server-daemon` remain
   explicitly private to each effective auth home.
2. Define daemon identity by Codex binary path/version/digest, effective
   `CODEX_HOME`, `CODEX_SQLITE_HOME`, physical rollout/writer-lock domain, and
   launch-config fingerprint.
3. Implement a real WebSocket-over-Unix-domain-socket transport; the current
   JSONL stdio client and `app-server proxy` are not drop-in equivalents.
4. Distinguish shuv-owned daemons from external daemons. Never stop an external
   owner.
5. Migrate only while quiescent: drain active turns, stop per-session children,
   verify writer-lock release, attach/probe the daemon, then resume authorized
   threads.
6. Route Desktop/TUI through the same daemon explicitly. Abort on writer,
   identity, version, or ownership mismatch instead of starting a second
   manager.
7. Ship read-only external discovery before enabling external writes.

This follow-up is deliberately outside v1 and must not be implied by the v1
thread inventory or release notes.
