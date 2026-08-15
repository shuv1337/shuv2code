# Phase 4: Call Through the Real Thread Lifecycle

Status: proposed

## Overview and motivation

An idle-thread demo is not a complete Call product. This slice makes voice a true input/output medium for the thread's existing lifecycle: active turns, steering, tools, approvals, user input, interruption, navigation, archive/delete, and reconnect.

The governing rule is reuse. Voice projects the ordinary thread state and invokes ordinary commands; it does not create voice-specific versions of thread lifecycle behavior.

## User-visible result

A user can keep a Call active while the thread works, answer or inspect ordinary approvals, speak another utterance according to the thread's dispatch policy, interrupt speech without accidentally cancelling tools, navigate away and back, and recover from a transient connection failure without retargeting or duplicating work.

## Decisions required before implementation

1. Confirm the active-turn utterance default. Recommendation: consume the same effective steering preference as typed chat.
2. Confirm archive/delete behavior. Recommendation: prevent new input, end safely, and explain; require confirmation if the action originates while a Call is active.
3. Confirm ambient narration fallback behavior. Recommendation: relay bounded, speech-safe assistant sentences while keeping the full durable response in the thread.

## Deliverables

| ID  | Feature                       | Layer                 | Actions                                                                       | Status   |
| --- | ----------------------------- | --------------------- | ----------------------------------------------------------------------------- | -------- |
| 4.1 | Active-turn dispatch          | Client runtime/server | Share typed-chat start/steer decision; preserve deterministic command IDs     | Proposed |
| 4.2 | Activity projection           | Client runtime        | Derive bounded thinking/acting/waiting summaries from ordinary thread state   | Proposed |
| 4.3 | Speech-channel continuity     | Server/client runtime | Correlate ambient narration with ordinary turn activity and reconnect         | Proposed |
| 4.4 | Barge-in                      | Transport/web         | Stop speech playback; do not implicitly interrupt thread tools/turn           | Proposed |
| 4.5 | Approval and input continuity | Web                   | Surface concise waiting state and route user to existing controls             | Proposed |
| 4.6 | Navigation pinning            | Web shell             | Keep exact owner; collapse globally away from owner; navigate back explicitly | Proposed |
| 4.7 | Terminal owner behavior       | Server/web            | Handle archived/deleted/unavailable owner without retargeting                 | Proposed |
| 4.8 | Reconnect semantics           | Server/web            | Fresh transport generation; no replayed utterance or duplicate speech         | Proposed |

## Shared dispatch policy

Extract the existing composer decision into client-runtime or a pure shared web policy consumed by both typed chat and Voice:

```ts
type ThreadUtteranceDispatch =
  | { kind: "start" }
  | { kind: "steer"; expectedTurnId: TurnId }
  | { kind: "queue" }
  | { kind: "blocked"; reason: string };
```

The Voice call bridge validates the chosen command against current server state. It never trusts a stale browser decision. If the state changed, it returns a bounded recoverable status and does not guess.

## Spoken response channel

Phase 3 already establishes the response contract: a delegated ordinary turn receives hidden voice-mode context, and its canonical assistant stream feeds a bounded, speech-safe narration relay. Spoken chunks drive temporal Call text and provider speech while the detailed ordinary response remains durable thread content. Phase 4 extends correlation, reconnect, and activity behavior around that channel rather than adding a second persisted `spokenText` schema or reading long final responses verbatim.

Raw partial transcripts, audio levels, and realtime-only conversation remain ephemeral. Explicitly delegated user text and normal assistant output remain durable messages.

## Activity projection

Add one pure projector that maps the called thread plus media state to a bounded semantic presentation:

- partial user text while speaking;
- final user text through early thinking;
- “Thinking” when no meaningful action exists;
- a short sanitized action summary for current tool/work activity;
- “Waiting for approval” or “Waiting for input” with a route to existing controls;
- exactly the spoken text while audio is playing and briefly afterward.

The projector does not parse rendered Markdown or infer tools from DOM state. It consumes normalized client-runtime entities.

## Navigation and owner lifetime

- `VoiceSessionProvider` at app root remains the media owner.
- The Call owner thread ID is immutable for one active session.
- When the current route differs, `VoiceSessionTray` names the called thread and provides Return, Mute, and End.
- Reopening the panel elsewhere displays the pinned call context; it does not bind to the visible thread.
- If the owner becomes archived/deleted/unavailable, server dispatch closes; media teardown remains possible; the UI explains the terminal state.

## Files

### New

- `packages/client-runtime/src/voice/threadVoiceDispatch.ts`
- `packages/client-runtime/src/voice/threadVoiceDispatch.test.ts`
- `packages/client-runtime/src/voice/threadVoiceActivity.ts`
- `packages/client-runtime/src/voice/threadVoiceActivity.test.ts`
- `apps/web/src/components/voice/VoiceCallLifecycle.tsx`
- `apps/web/src/components/voice/VoiceCallLifecycle.test.tsx`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `packages/client-runtime/package.json`
- `packages/client-runtime/src/state/threadCommands.ts`
- `packages/client-runtime/src/state/threadReducer.ts`
- `packages/client-runtime/src/state/threadReducer.test.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/decider.turnSteer.test.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.test.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/web/src/voice/VoiceSessionProvider.tsx`
- `apps/web/src/components/voice/VoiceSessionTray.tsx`
- `apps/web/src/components/voice/VoiceSessionTray.test.tsx`
- `apps/web/src/components/voice/VoiceSurface.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.logic.test.ts`

### Intentionally unchanged

- Existing approval resolution RPCs and UI panels.
- Existing user-input resolution RPCs and UI panels.
- Controller action/mutation semantics.
- Mobile presentation.

## Implementation order

1. Ratify the three review-gate decisions.
2. Extract and test shared utterance dispatch policy.
3. Extend ambient narration correlation and fail-closed reconnect behavior without a new persistent message stream.
4. Expand Call bridge correlation and activity selection.
5. Add pure activity projection and wire existing thread entities.
6. Implement barge-in and navigation pinning.
7. Add owner terminal-state and reconnect behavior.
8. Exercise approvals, tools, steering, navigation, and reconnect in the integrated browser.

## Focused verification

- An utterance during an active turn follows the same effective policy as typed chat.
- Barge-in halts audio quickly but emits no `thread.turn.interrupt` by itself.
- Tool work continues while speech is stopped.
- Waiting approval/input is reflected in Voice and resolved through existing controls.
- Each ambient narration chunk is spoken/displayed once; reconnect never causes long final text to be replayed or read verbatim.
- Navigating away never changes owner; Return opens the exact thread.
- Reconnect creates a new transport generation without replaying final transcript or assistant speech.
- Archive/delete transitions to a terminal explanation and releases media exactly once.

Commands:

- `vp test run packages/contracts/src/orchestration.test.ts packages/contracts/src/realtimeVoice.test.ts`
- `vp test run packages/client-runtime/src/voice/threadVoiceDispatch.test.ts packages/client-runtime/src/voice/threadVoiceActivity.test.ts packages/client-runtime/src/state/threadReducer.test.ts`
- `vp test run apps/server/src/voice/Layers/VoiceCallBridge.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/components/voice/VoiceCallLifecycle.test.tsx apps/web/src/components/voice/VoiceSessionTray.test.tsx apps/web/src/components/ChatView.logic.test.ts`
- Integrated web scenarios: active tool call, approval, user input, barge-in, navigate away/back, server reconnect, archive owner.

## Exit criteria

- Call participates in the ordinary thread lifecycle without duplicate lifecycle systems.
- Speech interruption and agent-work interruption are separate operations.
- Activity, temporary text, and speech derive from one correlated thread/media projection.
- Call ownership stays exact across navigation and reconnect.
