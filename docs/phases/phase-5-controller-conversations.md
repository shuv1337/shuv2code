# Phase 5: Controller Conversations

Status: proposed

## Overview and motivation

Controller is not an ordinary project thread, but it is a durable conversation. The current backend keeps one environment binding and offers reset/archive; the lab's list, archive, restore, and resume behavior is mock state.

This slice makes Controller history a real product without putting managed controller threads into the ordinary sidebar.

## User-visible result

The Controller mode shows recent Controller conversations. A user can begin a fresh one, resume a previous one, archive it, view archived controllers, and restore one. Exactly one conversation is the active Controller binding for the environment.

## Proposed identity model

Use multiple existing `voice-controller` projection threads as the durable conversations. Do not add a second conversation table. Add a dedicated query/service boundary so managed controller records never pass through ordinary thread-list selectors.

The environment binding identifies the currently active Controller runtime:

```text
environment -> active controller conversation -> provider runtime
```

Inactive Controller conversations retain provider-authoritative history but have no live controller runtime. Resuming rotates the binding/control epoch under the existing serialized lifecycle lock.

## Decision required before implementation

Confirm restore behavior. Recommendation:

- **Restore** only removes the archived marker.
- **Resume** explicitly activates the conversation and replaces the current binding after safe media/runtime teardown.

Keeping these separate avoids an archive-management action unexpectedly taking over the active Controller.

## Deliverables

| ID  | Feature              | Layer                | Actions                                                                   | Status   |
| --- | -------------------- | -------------------- | ------------------------------------------------------------------------- | -------- |
| 5.1 | Conversation catalog | Contracts/server     | List active/archived controller summaries with stable pagination          | Proposed |
| 5.2 | New Controller       | Server               | Create and activate a fresh conversation under serialized lifecycle       | Proposed |
| 5.3 | Resume Controller    | Server               | Validate identity, rotate binding/epoch, recover provider history/runtime | Proposed |
| 5.4 | Archive/restore      | Server               | Change managed projection archival state without leaking to thread APIs   | Proposed |
| 5.5 | Controller navigator | Web                  | Replace lab-local catalog with server data and explicit actions           | Proposed |
| 5.6 | Reset retirement     | Contracts/web/server | Replace ambiguous reset flow; remove compatibility RPC in this phase      | Proposed |

## API schemas

```ts
type VoiceControllerConversationSummary = {
  controllerThreadId: ThreadId;
  title: string;
  hostProjectId: ProjectId;
  providerInstanceId: ProviderInstanceId;
  updatedAt: IsoDateTime;
  archivedAt: IsoDateTime | null;
  active: boolean;
};

type VoiceListControllerConversationsInput = {
  archived: boolean;
  cursor?: string;
  limit?: number;
};

type VoiceCreateControllerConversationInput = VoiceEnsureControllerInput;

type VoiceResumeControllerConversationInput = {
  controllerThreadId: ThreadId;
};

type VoiceSetControllerConversationArchivedInput = {
  controllerThreadId: ThreadId;
  archived: boolean;
};
```

Responses return the authoritative summary and, for create/resume, the active `VoiceControllerIdentity`. All operations are environment-scoped by the authenticated RPC connection; environment ID is not accepted as free client authority.

## Server behavior

- Catalog queries only `purpose = voice-controller` and excludes deleted rows.
- History remains provider-authoritative through the existing `getControllerHistory` path.
- Create uses the existing controller provisioning logic with a fresh ID, then atomically activates the binding.
- Resume verifies purpose, archival state, provider availability, runtime ceiling, and host anchor before binding rotation.
- Resume safely stops the previous controller media/runtime, increments its control epoch, and fences outstanding actions before activation.
- Archive of the active conversation is rejected until it is inactive, or the UI performs an explicit switch/new operation first.
- Restore does not activate.

## Files

### New

- `apps/server/src/persistence/Services/VoiceControllerConversations.ts`
- `apps/server/src/persistence/Layers/VoiceControllerConversations.ts`
- `apps/server/src/persistence/Layers/VoiceControllerConversations.test.ts`
- `apps/web/src/components/voice/VoiceControllerNavigator.tsx`
- `apps/web/src/components/voice/VoiceControllerNavigator.test.tsx`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `packages/contracts/src/rpc.ts`
- `packages/client-runtime/src/operations/realtimeVoice.ts`
- `packages/client-runtime/src/state/realtimeVoice.ts`
- `apps/server/src/voice/Services/VoiceControllerService.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.test.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/web/src/components/voice/VoiceSurface.tsx`
- `apps/web/src/components/voice/VoiceControllerDetails.tsx`
- `apps/web/src/components/voice/VoiceControllerManagement.logic.ts`
- `apps/web/src/components/voice/VoiceControllerManagement.logic.test.ts`

### Intentionally unchanged

- Ordinary thread list/search/archive contracts.
- Call ownership and turn lifecycle.
- Controller MCP action semantics.
- Voice visual effect.

## Implementation order

1. Ratify restore/resume semantics.
2. Add repository catalog tests against standard, controller, transport, archived, and deleted fixtures.
3. Add schemas/RPCs and authorization mapping.
4. Refactor existing ensure/reset internals into create/activate/archive operations under the same lifecycle lock.
5. Implement the real navigator and optimistic-disable states, not optimistic identity changes.
6. Remove reset RPC and UI once all callers use explicit lifecycle operations.
7. Demonstrate new/resume/archive/restore with server restart between actions.

## Focused verification

- Catalog contains only Controller conversations and stable active/archived pagination.
- Create twice yields two durable conversations but one active binding/runtime.
- Resume rotates control epoch and fences the previous runtime/actions.
- Restore does not activate; resume does.
- Active Controller cannot be archived implicitly.
- Provider history survives stop, server restart, and resume.
- No controller conversation appears in ordinary thread lists.

Commands:

- `vp test run packages/contracts/src/realtimeVoice.test.ts`
- `vp test run apps/server/src/persistence/Layers/VoiceControllerConversations.test.ts apps/server/src/voice/Layers/VoiceControllerService.test.ts apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/components/voice/VoiceControllerNavigator.test.tsx apps/web/src/components/voice/VoiceControllerManagement.logic.test.ts`
- Integrated web: create A, create B, archive A, show archived, restore A, resume A, restart server, and verify its history.

## Exit criteria

- Controller conversations have real list/create/resume/archive/restore behavior.
- Exactly one environment binding remains authoritative.
- Managed controller records never use ordinary thread inventory UI.
- Ambiguous reset behavior is removed rather than retained as parallel lifecycle complexity.
