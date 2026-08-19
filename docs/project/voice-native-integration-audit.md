# Voice native integration audit and discussion plan

Status: discussion draft  
Last updated: 2026-08-13  
Scope: product model, backend boundaries, shared client state, native surfaces, and verification  
Approval: not approved for implementation

## Purpose

The standalone Voice lab has done its job: it established a stronger interaction and visual direction without making every iteration depend on a packaged application build. It is not an implementation blueprint by itself.

The production Voice stack and the lab currently describe different products. Production implements an environment controller with an optional current-thread target. The lab presents two distinct modes:

- **Controller** is an environment-wide agent that can inspect, create, and manage multiple threads.
- **Call** is a voice-native continuation of one ordinary thread.

Native integration must make those meanings true in the backend, contracts, persistence, and shared client state before presenting them as true in the UI.

## Settled product truths

These are direct constraints from the design discussion and should not be reopened accidentally during implementation.

1. Voice is a native surface, not an ordinary project thread and not a workspace.
2. Controller and Call are different modes with different ownership and context semantics.
3. Controller is environment-wide. It may use the currently visible thread when relevant, but it is not inside that thread.
4. Call is owned by exactly one ordinary thread. Spoken user and assistant turns belong to that thread's durable history.
5. Controller and transport implementation threads must not appear in ordinary thread navigation, search, archive views, or project history.
6. Controller history is useful and should support starting a new conversation, navigating prior conversations, archiving, restoring, and resuming.
7. Call shows only temporally relevant context: live user transcription, concise current activity, and the words being spoken by the agent. The ordinary thread remains the durable record.
8. Controller conversation text should retain a visually distinct voice identity. The established warm orange treatment is useful because it prevents two adjacent transcripts from reading as one thread.
9. Voice may be off in either mode. Starting voice must remain obvious from the surface, composer entry, and collapsed ongoing-session affordance.
10. The procedural presence should move continuously and gradually, respond to listening/thinking/speaking, avoid abrupt palette changes, remain stable during panel relayout, respect reduced motion and background visibility, and degrade gracefully on constrained hardware.
11. The standalone lab remains available for fast visual and signal iteration. Test controls remain development-only.

## Audited implementation reality

### Foundations worth retaining

The existing stack already contains valuable, security-sensitive work:

- complete transport fences and monotonically sequenced event replay;
- serialized controller lifecycle operations;
- durable controller action and mutation idempotency;
- control-epoch authorization and exact MCP credential binding;
- provider history recovery for controller conversations;
- browser media ownership and exactly-once lease release;
- WebRTC negotiation, reconnect, permission, and autoplay handling;
- hidden thread purposes and web filtering for managed Voice threads;
- an app-root Voice session provider that survives route navigation;
- a dependency-free WebGL presence with a fixed backing store, low-power preference, visibility pausing, reduced-motion handling, constrained-renderer fallback, and adaptive 30 fps active / 6 fps ambient cadence.

This foundation should be refactored into clearer mode-specific services, not discarded.

### Blocking mismatches

| Area                | Current reality                                                                                  | Required target                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Call ownership      | Every session requires a controller thread. `conversation` means controller conversation.        | Call is discriminated from Controller and bound to an exact standard thread.                                 |
| Call durability     | Realtime transcripts and assistant output belong to controller/transport plumbing.               | Final user utterances and assistant responses become ordinary thread turns with voice presentation metadata. |
| Transport resources | Every generation creates a projected `voice-transport` thread, then archives it on a clean stop. | Transport is internal runtime infrastructure, independently reaped, and never part of user thread inventory. |
| Controller history  | Backend has one environment binding plus reset/archive.                                          | User-facing controller conversations can be listed, started, archived, restored, selected, and resumed.      |
| Activity state      | The lab infers phases locally; the server mostly emits listening/stopped plus action events.     | One merged activity model drives status, presence, transcript, and audio consistently.                       |
| Native surface      | Production `VoiceSurface` is Controller-only and nested inside `ChatView`.                       | Environment Controller exists without an active thread; Call appears only with an exact callable thread.     |
| Collapsed UI        | The tray assumes Controller semantics and labels.                                                | The collapsed affordance reflects the active mode, owner, phase, mute, and end/reconnect actions.            |
| Mobile              | Managed purposes can leak into mobile thread lists; no Voice surface exists.                     | Filtering is shared across clients; mobile consumes the same mode and lifecycle contracts when scheduled.    |
| PCM fallback        | Client wiring omits audio append and output playback handling.                                   | PCM either becomes a complete supported transport or is explicitly excluded from the first release.          |

### Specific implementation evidence

- `VoiceSessionStartInput` requires `controllerThreadId` and only distinguishes `conversation` from `transcription` in `packages/contracts/src/realtimeVoice.ts`.
- `VoiceSessionController.start` always ensures a controller before starting media in `apps/web/src/voice/VoiceSessionController.ts`.
- `VoiceTransportCoordinator.startTransport` creates a projected `voice-transport` thread for every client generation in `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`.
- Clean stop archives that transport thread, but startup cleanup only fences the current controller's stale open lease. Browser loss and historical rows therefore need a deliberate reaping/migration policy.
- The lab's controller conversation list, archive/restore behavior, and Call mode are local mock state in `apps/web/src/components/voice/VoiceSurfaceLab.tsx`.
- The production surface loads one controller history and retargets it as the visible thread changes in `apps/web/src/components/voice/VoiceSurface.tsx`. That behavior is appropriate for Controller and incorrect for Call.
- Web filters nonstandard thread purposes in `apps/web/src/state/entities.ts`; mobile list builders currently do not share that predicate.
- The Voice right-panel surface is environment-pinned but rendered from `ChatView`, which returns early when no thread is active.

## Target domain model

### Surface mode

The native surface owns presentation mode, while the active audio session owns runtime mode.

```ts
type VoiceSurfaceMode = "controller" | "call";

type VoiceSessionOwner =
  | { type: "controller"; controllerConversationId: VoiceControllerConversationId }
  | { type: "thread-call"; threadId: ThreadId }
  | { type: "transcription-test" }; // development-only
```

Only one media session should be active per environment in the first implementation. Changing the selected surface mode does not silently reinterpret an active session. If ownership would change, the UI must end or explicitly transfer the session.

### Controller

Controller is an environment-level conversational resource with an internal execution anchor. The host project may remain necessary to start a provider runtime, but it should not define the user's mental model or appear as the controller's scope.

Controller responsibilities:

- maintain its own durable conversational history;
- discover and inspect authorized ordinary threads;
- create and manage ordinary threads through explicit controller actions;
- optionally use the currently visible thread as a bounded, untrusted reference;
- report accepted, provider-confirmed, completed, failed, waiting, and stale states honestly;
- never treat mute, barge-in, or ending Voice as an instruction to interrupt a target thread.

### Call

Call is an interaction mode for one exact standard thread. It is not Controller with a target hint.

Recommended data path:

1. An internal media transport captures audio and produces partial/final user transcription.
2. The final utterance is dispatched to the exact standard thread through the ordinary turn/steer lifecycle with a voice-mode marker.
3. The standard thread model receives an instruction that the user is in a call and may not be reading the full timeline.
4. Ordinary activities and tool calls continue to appear in the thread normally.
5. The call projection derives a bounded temporal status from those activities.
6. The assistant response contains or produces an explicitly identified spoken segment.
7. That spoken segment is sent to the active media transport and shown as temporal assistant text in the Call surface.
8. The durable thread retains the user utterance, assistant response, and enough metadata to explain what was spoken. Raw audio and partial transcript deltas remain ephemeral.

This keeps the thread authoritative without requiring the realtime provider session itself to masquerade as the standard thread. The internal transport can remain provider-specific while Call semantics remain provider-neutral.

### Transport

Transport identity is not conversation identity.

The preferred end state is a dedicated internal runtime resource that does not create `projection_threads` rows. If the provider runtime temporarily requires a thread-shaped identity, use a non-user projection or a bounded stable internal identity with an explicit reaper. Do not create an indefinitely growing ordinary orchestration thread per reconnect generation.

Required lifecycle properties:

- one open media lease per environment;
- exact generation fencing and idempotent start/stop;
- heartbeat or connection-owned cancellation for abandoned clients;
- startup reconciliation across every stale Voice lease, not only the current binding;
- bounded retention or deletion of closed transport rows;
- migration/cleanup for existing projected transport ghosts;
- no appearance in any user-facing thread selector on web or mobile.

### Activity and temporal presentation

The surface should consume a single projection rather than infer unrelated signals in multiple components.

```ts
type VoiceActivity =
  | { type: "idle" }
  | { type: "requesting-permission" }
  | { type: "connecting" }
  | { type: "listening"; inputLevel: number }
  | { type: "user-speaking"; inputLevel: number; partialText: string }
  | { type: "thinking"; summary?: string }
  | { type: "acting"; summary: string }
  | { type: "assistant-speaking"; outputLevel: number; spokenText: string }
  | { type: "muted" }
  | { type: "reconnecting" }
  | { type: "error"; code: string; recoverable: boolean };
```

Input/output levels remain high-frequency client-side refs and must not cause React rerenders. Semantic phases and bounded text are low-frequency state. The presence renderer blends palette and energy over time and never remounts merely because the panel resizes or the phase changes.

## Decisions to resolve together

The recommendations below are proposed defaults, not approvals.

### D1. Controller conversation identity

Question: Are prior controller conversations multiple controller threads, or sessions within one permanent controller thread?

Recommendation: model them as multiple durable controller conversations with at most one active runtime binding per environment. Archiving a conversation removes it from recent history; resuming it activates that conversation and safely rotates the runtime binding if needed. This matches the user's expectation that a fresh controller can be launched while an older one remains resumable.

### D2. Controller execution anchor

Question: What does `hostProjectId` mean for an environment-wide controller?

Recommendation: treat it as internal runtime placement only. Prefer an explicit environment default or last viable project, and allow safe anchor migration without presenting it as controller identity.

### D3. Call input during an active thread turn

Question: Does a spoken utterance steer an active turn, queue a follow-up, or ask the user?

Recommendation: use the same provider-capability-aware dispatch policy as typed chat. Show the chosen action in temporal status. Do not create a Voice-only steering rule.

### D4. Spoken response contract

Question: Is the full assistant final response spoken, or can the model distinguish durable detail from the spoken segment?

Recommendation: support explicit `spokenText` metadata while defaulting to the full final response when absent. This permits concise speech with richer durable text without making the call surface guess from rendered Markdown.

### D5. Barge-in semantics

Question: What does speaking over the agent interrupt?

Recommendation: immediately stop local/transport speech playback. Do not interrupt the standard thread's tool work or active turn unless the resulting user utterance explicitly dispatches through normal steer/interrupt rules.

### D6. Navigation during Call

Question: What happens when the user navigates away from the called thread?

Recommendation: the call remains bound to its original thread and collapses to the global affordance. Opening the Voice surface elsewhere clearly names the called thread and offers navigation back. It never retargets automatically.

### D7. Archived/deleted called thread

Question: What happens if the owner thread becomes unavailable during a call?

Recommendation: end input dispatch, preserve safe local call teardown, and show a terminal explanation. Do not silently redirect to Controller or another thread.

### D8. Entry points

Question: Which mode do the different Voice buttons start?

Recommendation:

- thread composer microphone: Call this thread;
- right-panel Voice entry: open the surface in its last selected mode, with Controller as the no-thread fallback;
- global collapsed affordance: reopen the active session;
- explicit global command: Controller.

### D9. Initial platform scope

Question: web/desktop first, or web/desktop and mobile together?

Recommendation: make contracts, filtering, and shared state cross-platform immediately; ship and validate the native web/desktop surface first; build mobile UI and native media after the lifecycle is stable unless simultaneous mobile delivery is required.

### D10. PCM fallback

Question: Is websocket/PCM required in the first native release?

Recommendation: either complete input append, output playback, backpressure, error propagation, and tests before advertising it, or explicitly gate the first release to WebRTC-capable clients. A partially wired fallback should not be presented as supported.

### D11. Temporal text behavior

Question: How long do partial/final utterances, status summaries, and spoken responses remain visible?

Recommendation: replace partials in place; retain the latest final user utterance through thinking; replace it with current action status when materially useful; show spoken response while playing and briefly after; clear back to ambient status without building a second scrollable transcript.

## Proposed implementation sequence

This sequence is intentionally gated. Later phases should not begin until the relevant decisions above are accepted.

### Phase 0: product and protocol decisions

- Resolve D1-D11.
- Write the approved mode, ownership, persistence, interruption, and temporal-text state machines.
- Define first-release platform and transport support.
- Convert this dossier into a numbered implementation phase only after approval.

Exit gate: Controller and Call can be explained without reference to UI mock implementation details.

### Phase 1: shared domain and visibility boundaries

- Add discriminated session ownership and mode schemas.
- Move managed-purpose visibility into shared client-runtime code and consume it on web and mobile.
- Define capability discovery independently from `provider.driver === "codex"` UI checks.
- Define spoken-response metadata and bounded temporal activity events.
- Add contract tests for every valid and invalid mode/owner combination.

Exit gate: impossible states are rejected at the schema boundary, and no client can list managed Voice threads as ordinary threads.

### Phase 2: internal transport lifecycle

- Separate media transport identity from orchestration conversation identity.
- Remove or bound per-generation projected transport threads.
- Add disconnect/heartbeat cancellation, all-lease startup reconciliation, retention, and historical cleanup.
- Complete or gate PCM.
- Add a real coordinator harness for replay, conflict, stale startup, clean stop, crash recovery, and projection counts.

Exit gate: repeated start/stop/reconnect/crash cycles produce one active lease, no visible ghost threads, and bounded internal records.

### Phase 3: direct-thread Call backend

- Start a Call against an exact standard thread with authorization checks.
- Route final utterances through ordinary turn/steer dispatch.
- Inject voice-mode guidance without weakening thread permissions.
- Project ordinary thread activity into bounded Call status.
- Carry spoken response metadata to transport speech and the live Call event stream.
- Keep partial transcripts and raw media ephemeral.

Exit gate: a real Call adds one coherent user/assistant exchange to the selected thread, speaks the identified response, and never creates a controller action.

### Phase 4: controller conversation lifecycle

- Implement list/new/select/archive/restore/resume semantics from D1.
- Separate pure history reads from runtime activation.
- Preserve one active environment runtime binding and explicit authorization rotation.
- Make current-thread reference optional and bounded; never auto-apply Call semantics.

Exit gate: Controller history behaves like the lab's product model with durable backend truth and no ordinary sidebar rows.

### Phase 5: shared client session model

- Replace the Controller-only session controller with mode-aware ownership and projections.
- Merge semantic server events with microphone/output energy refs.
- Ensure stop, reconnect, route changes, and ownership changes are fenced and idempotent.
- Expose mode-specific view models for full surface, collapsed affordance, and composer entry.

Exit gate: all presentation surfaces observe one source of truth and cannot retarget an active Call accidentally.

### Phase 6: native web/desktop surface

- Extract production components from the lab; do not promote the monolithic mock component.
- Compose environment Voice above thread-only `ChatView` routing.
- Implement Controller and Call layouts, start states, history navigation, archive/restore, temporal text, controls, and mode-aware collapsed affordance.
- Connect the procedural presence to real input/output energy and semantic activity.
- Preserve canvas/context identity across right-panel resize, maximize, sheet transitions, and phase changes.
- Update selector copy so it describes Voice rather than a persistent environment thread.

Exit gate: the packaged desktop app and browser both match the approved mental model and visual behavior.

### Phase 7: mobile surface

- Reuse shared ownership, visibility, activity, and lifecycle state.
- Implement native media transport and platform permission handling.
- Adapt the surface and collapsed affordance to mobile navigation and background rules.

Exit gate: representative iOS and Android behavior matches the same Controller/Call semantics.

### Phase 8: release hardening

- Run real-provider start/stop/reconnect/server-restart and abandoned-client loops.
- Verify approvals, user input, failures, barge-in, archived owners, and active-turn dispatch.
- Measure CPU/GPU/frame time and memory in active, ambient, background, reduced-motion, and constrained-renderer states.
- Capture relayout filmstrips or pixel diffs to prove there is no canvas flash.
- Run migration cleanup against copies of existing Voice-heavy state.

Exit gate: lifecycle, visibility, resource, accessibility, and performance budgets are documented and pass.

## Verification matrix

| Concern            | Unit/contract                      | Service/integration             | Product verification                                            |
| ------------------ | ---------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| Mode ownership     | schema matrix                      | authenticated RPC routing       | Controller and Call cannot be confused visually or behaviorally |
| Ghost prevention   | shared visibility predicate        | projection and migration counts | web/mobile thread lists contain only standard threads           |
| Transport cleanup  | fence/reaper policy                | reconnect/crash/startup loops   | no accumulated visible or open transport resources              |
| Call durability    | spoken metadata schema             | exact standard-thread turn flow | transcript, durable response, spoken text, and presence agree   |
| Controller history | lifecycle reducer                  | list/archive/restore/resume RPC | user can navigate and resume without sidebar ghosts             |
| Permissions        | capability/runtime lattice         | read/operate and target checks  | failures are actionable and never widen authority               |
| Media              | transport ownership/backpressure   | WebRTC and optional PCM         | mic, playback, mute, barge-in, and autoplay recovery work       |
| Presence           | render policy and context lifetime | activity projection             | no relayout flash; gradual state and palette movement           |
| Resource use       | cadence/degrade policy             | telemetry/profile harness       | active/idle/background budgets pass                             |

## Immediate next discussion

The first useful discussion is not component layout. It is the four decisions that determine the data model:

1. D1: controller conversation identity;
2. D3: Call dispatch during an active turn;
3. D4: spoken response metadata;
4. D9/D10: first-release platforms and transport support.

Once those are settled, the protocol and persistence state machines can be written precisely and this document can be promoted into the repository's formal implementation-plan system.
