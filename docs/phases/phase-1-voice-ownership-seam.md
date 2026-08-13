# Phase 1: Voice Ownership Seam

Status: active — checkpoint 1A complete; additive 1B/1D compatibility seam implemented

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

| ID  | Feature                   | Layer                     | Actions                                                                         | Status             |
| --- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| 1.1 | Session-owner schema      | Contracts                 | Add owner union; reject mixed identities; update result/fence/event schemas     | Compatibility seam |
| 1.2 | Environment media lease   | Server persistence        | Migrate lease ownership and enforce one open lease per environment              | Proposed           |
| 1.3 | Owner-aware session state | Client runtime/web        | Carry owner through reducer and controller without changing Controller UX       | Wire seam          |
| 1.4 | Shared thread visibility  | Client runtime/web/mobile | Export one predicate and remove client-local policy                             | Complete           |
| 1.5 | Compatibility proof       | Tests/web                 | Prove current Controller startup, transcript, stop, and reconnect are unchanged | Complete           |

## Contract and API design

```ts
type VoiceSessionOwner =
  | { kind: "controller"; controllerThreadId: ThreadId }
  | { kind: "thread-call"; threadId: ThreadId }
  | {
      kind: "transcription-test";
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

The implementation deliberately stages this in two boundaries. The current compatibility seam makes `environmentId` and `owner` additive while the live coordinator remains controller-shaped. First-party web callers already send the new fields and `transport: { type: "webrtc", offerSdp }`; old clients can still negotiate during the transition. Checkpoint 1D makes owner routing authoritative, and its final cleanup removes the legacy top-level `offerSdp` and required `controllerThreadId` anchor together. The bridge is named, tested, and has that explicit deletion checkpoint.

Each owner branch is decoded strictly with excess-property rejection. A payload containing fields from another branch—for example `kind = controller` plus `threadId`—is invalid rather than silently stripped by `Schema.Union` decoding.

`VoiceSessionStartResult` is discriminated by owner. It returns `controller` only on the Controller branch. Start, stop, realtime ingress, PCM append, subscribe, server events, and the fence all carry the same environment and exact owner identity. Mixed-owner round trips are rejected.

`thread-call` is schema-valid but operationally unavailable until Phase 3. In this phase the server returns a structured `unsupported_owner` failure before microphone acquisition, lease reservation, projection creation, or provider negotiation.

The transcription branch is development-only. `providerAnchorThreadId` supplies provider/project/model placement but does not make the test an ordinary Call.

## Persistence design

Migration 043 rebuilds the complete `voice_transport_sessions` → `voice_controller_actions` → `voice_controller_mutations` foreign-key chain, following Migration 042's safe SQLite replacement order. The transport table gains:

- `owner_kind`: `controller | thread | transcription`;
- `owner_id`: the controller thread, ordinary thread, or request ID;
- `anchor_thread_id`: nullable except for provider placement that cannot be derived from the owner;
- the existing environment, transport, runtime, generation, realtime, and lifecycle fields;
- a partial unique index on `environment_id` for negotiating/active/closing rows.

The old `controller_thread_id` values migrate to `owner_kind = controller`. Before creating the environment-level partial unique index, the migration deterministically keeps the newest open row per environment and marks other open rows fenced with `updated_at` and `closed_at` set to migration time. Tests seed duplicate open controllers plus existing actions/mutations and prove data and foreign-key integrity after migration.

Controller action creation verifies `owner_kind = controller AND owner_id = controllerThreadId`. Controller-specific tables remain controller-specific.

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
- `apps/server/src/persistence/Layers/VoiceControllerActions.ts`
- `apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `apps/server/src/voice/Services/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/state/entities.ts`
- `apps/web/src/state/entities.test.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- the focused archived-settings test selected from the existing settings test suite
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/mobile/src/features/home/homeThreadList.ts`
- `apps/mobile/src/features/home/homeThreadList.test.ts`
- `apps/mobile/src/features/threads/threadListV2.ts`
- `apps/mobile/src/features/threads/threadListV2.test.ts`
- `apps/mobile/src/features/archive/archivedThreadList.ts`
- `apps/mobile/src/features/archive/archivedThreadList.test.ts`

### Intentionally unchanged

- Controller action/mutation semantics and MCP authorization.
- Voice surface visual design.
- Ordinary thread turn schemas and dispatch.
- Provider gateway negotiation behavior.

## Independently verifiable checkpoints

### 1A. Shared visibility

Move the predicate and consume it in web/mobile active, search, and archived selectors. This is independently shippable and is verified in both clients before wire changes.

### 1B. Owner wire/domain compatibility seam — implemented

Add strict owner branches across start/result/fence/stop/ingress/append/subscribe/events. During this named compatibility seam, owner and environment are optional and the existing controller anchor remains required; first-party web sends both identities. Mixed-field owners are rejected, owner/anchor mismatches are rejected server-side, and schema-valid thread Call returns `unsupported_owner` before a transport lease exists. Remove the compatibility anchor and legacy top-level `offerSdp` only when checkpoint 1D makes owner routing authoritative.

### 1C. Migration and environment lease

Rebuild the complete foreign-key chain, resolve pre-existing environment conflicts, update transport and controller-action repositories, and prove two-owner/same-environment conflicts plus cross-environment independence.

### 1D. Coordinator and RPC authority

Replace controller-keyed coordinator/repository routing with exact owner routing; reject thread-call before side effects until Phase 3; retain exact owner across replay, reconnect, stop, and subscribe. Finish by deleting the named 1B compatibility anchor and legacy top-level `offerSdp`.

### 1E. Browser compatibility proof — implemented for the compatibility seam

Update client-runtime and `VoiceSessionController`, prove panel preference cannot retarget media, then run the existing Controller and transcription paths in the dev build.

## Verification

- `vp test run packages/contracts/src/realtimeVoice.test.ts`
- `vp test run packages/client-runtime/src/state/realtimeVoice.test.ts packages/client-runtime/src/state/threadVisibility.test.ts`
- `vp test run apps/server/src/persistence/Migrations/043_VoiceSessionOwnership.test.ts apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `vp test run apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/state/entities.test.ts`
- `vp test run apps/mobile/src/features/home/homeThreadList.test.ts apps/mobile/src/features/threads/threadListV2.test.ts apps/mobile/src/features/archive/archivedThreadList.test.ts`
- Run targeted format/lint/type checks for every affected package.
- Integrated web: start Controller, speak, observe transcript, stop, reconnect, and confirm no managed row appears.
- Integrated mobile: use `test-shuv2code-mobile` on one representative simulator and confirm controller and transport fixtures are absent from active, search, and archived navigation.

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
