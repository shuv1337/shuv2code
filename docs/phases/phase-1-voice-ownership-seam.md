# Phase 1: Voice Ownership Seam

Status: proposed

## Overview and motivation

The current start contract assumes every Voice session belongs to a controller thread. That makes Call impossible to represent honestly and makes the transport lease accidentally controller-shaped.

This is the plan's only deliberately enabling slice. It introduces the smallest semantic seam required by later slices while preserving the current Controller behavior end to end. It also closes the existing cross-client visibility leak.

## Before and after

| Before                                                        | After                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `VoiceSessionStartInput` always requires `controllerThreadId` | Start, stop, subscribe, and fence identify a discriminated owner       |
| One-open-lease constraint is keyed by controller thread       | One-open-media-lease constraint is keyed by environment                |
| Web has a local managed-purpose filter                        | Web and mobile consume one shared user-facing-purpose predicate        |
| Runtime state assumes `controller` is always present          | Runtime state exposes an owner; Controller projection is mode-specific |
| Mode and active media ownership can be conflated              | Selected surface mode and active session owner are distinct            |

## Deliverables

| ID  | Feature                   | Layer                     | Actions                                                                         | Status   |
| --- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------- | -------- |
| 1.1 | Session-owner schema      | Contracts                 | Add owner union; reject mixed identities; update result/fence/event schemas     | Proposed |
| 1.2 | Environment media lease   | Server persistence        | Migrate lease ownership and enforce one open lease per environment              | Proposed |
| 1.3 | Owner-aware session state | Client runtime/web        | Carry owner through reducer and controller without changing Controller UX       | Proposed |
| 1.4 | Shared thread visibility  | Client runtime/web/mobile | Export one predicate and remove client-local policy                             | Proposed |
| 1.5 | Compatibility proof       | Tests/web                 | Prove current Controller startup, transcript, stop, and reconnect are unchanged | Proposed |

## Contract and API design

```ts
type VoiceSessionOwner =
  | { kind: "controller"; controllerThreadId: ThreadId }
  | { kind: "thread"; threadId: ThreadId }
  | {
      kind: "transcription";
      requestId: VoiceTranscriptionRequestId;
      providerAnchorThreadId: ThreadId;
    };

type VoiceSessionStartInput = {
  owner: VoiceSessionOwner;
  clientSessionId: VoiceClientSessionId;
  generation: VoiceGeneration;
  transport: VoiceSessionStartTransport;
  voiceId?: string;
};
```

The legacy top-level `offerSdp` bridge may remain only if an already released client requires it; otherwise remove it in this phase. Do not retain both `controllerThreadId` and `owner` as long-lived equivalent fields.

`VoiceSessionStartResult` returns `owner`, transport identity, negotiation result, and event cursor. It returns Controller identity only on the Controller branch. `VoiceSessionFence` includes `environmentId` and the exact owner, preventing a valid transport fence from being replayed against another owner.

The transcription branch is development-only. `providerAnchorThreadId` supplies provider/project/model placement but does not make the test an ordinary Call.

## Persistence design

Migration 043 rebuilds `voice_transport_sessions` with:

- `owner_kind`: `controller | thread | transcription`;
- `owner_id`: the controller thread, ordinary thread, or request ID;
- `anchor_thread_id`: nullable except for provider placement that cannot be derived from the owner;
- the existing environment, transport, runtime, generation, realtime, and lifecycle fields;
- a partial unique index on `environment_id` for negotiating/active/closing rows.

The old `controller_thread_id` values migrate to `owner_kind = controller`. Existing controller action foreign keys continue to reference the transport session ID; controller-specific tables remain controller-specific.

## Client state design

`RealtimeVoiceSessionState` gains:

```ts
owner: VoiceSessionOwner | null;
```

Controller-only fields move under a nullable Controller presentation branch instead of being required for every connected session. The reducer remains generation-fenced. High-frequency audio levels remain outside React state.

Surface preference remains in `rightPanelStore`; active media ownership remains in `VoiceSessionProvider`. Changing the former must never mutate the latter.

## Files

### New

- `packages/client-runtime/src/state/threadVisibility.ts`
- `packages/client-runtime/src/state/threadVisibility.test.ts`
- `apps/server/src/persistence/Migrations/043_VoiceSessionOwnership.ts`
- `apps/server/src/persistence/Migrations/043_VoiceSessionOwnership.test.ts`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `packages/contracts/src/rpc.ts`
- `packages/client-runtime/package.json`
- `packages/client-runtime/src/operations/realtimeVoice.ts`
- `packages/client-runtime/src/state/realtimeVoice.ts`
- `packages/client-runtime/src/state/realtimeVoice.test.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/persistence/VoiceControlModels.ts`
- `apps/server/src/persistence/Services/VoiceTransportSessions.ts`
- `apps/server/src/persistence/Layers/VoiceTransportSessions.ts`
- `apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `apps/server/src/voice/Services/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/mobile/src/features/home/homeThreadList.ts`
- `apps/mobile/src/features/home/homeThreadList.test.ts`
- `apps/mobile/src/features/threads/threadListV2.ts`
- `apps/mobile/src/features/threads/threadListV2.test.ts`

### Intentionally unchanged

- Controller action/mutation semantics and MCP authorization.
- Voice surface visual design.
- Ordinary thread turn schemas and dispatch.
- Provider gateway negotiation behavior.

## Implementation order

1. Add contract union and invalid-combination tests.
2. Add migration/repository support and data migration tests.
3. Make server coordinator and Controller service owner-aware while routing only Controller and transcription.
4. Update client runtime and browser session controller.
5. Move the visibility predicate and consume it on web/mobile.
6. Run the existing Controller path as the phase demonstration.

## Verification

- `vp test run packages/contracts/src/realtimeVoice.test.ts`
- `vp test run packages/client-runtime/src/state/realtimeVoice.test.ts packages/client-runtime/src/state/threadVisibility.test.ts`
- `vp test run apps/server/src/persistence/Migrations/043_VoiceSessionOwnership.test.ts apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `vp test run apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/state/entities.test.ts`
- `vp test run apps/mobile/src/features/home/homeThreadList.test.ts apps/mobile/src/features/threads/threadListV2.test.ts`
- Integrated web: start Controller, speak, observe transcript, stop, reconnect, and confirm no managed row appears.
- Integrated mobile list check: controller and transport fixtures are absent from active and archived lists.

## Example workflow

1. Open an environment and choose Controller.
2. Start Voice and complete one spoken exchange.
3. Navigate and reconnect once.
4. End Voice.
5. Inspect active and archived thread lists on web and mobile fixtures.
6. Observe unchanged Controller behavior and zero managed Voice shells.

## Exit criteria

- Every session has exactly one schema-valid owner.
- Exactly one open media lease can exist per environment.
- Current Controller behavior remains operational.
- Managed purposes cannot appear in web or mobile user-facing selectors.
