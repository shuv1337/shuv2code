# Phase 3: Direct Call on an Idle Thread

Status: proposed

## Overview and motivation

This is the first new product slice. It makes Call true at the architecture boundary: the session is owned by one exact ordinary thread, the final spoken utterance enters that thread through its normal turn pipeline, and the normal assistant response is projected back into speech and temporary call text.

The slice is intentionally limited to an idle, callable thread. Running-turn behavior, tools/approvals, navigation, and barge-in are Phase 4.

## User-visible result

From an idle project thread, the user chooses **Call this thread**, starts the microphone, speaks, sees the live/final utterance temporarily, and hears the thread's assistant response while the same response appears temporarily in the Voice surface and durably in the ordinary thread.

No controller is ensured. No controller target is set. No controller action is created.

## End-to-end flow

```text
mic -> existing WebRTC transport -> final transcript
    -> VoiceCallBridge -> ordinary thread.turn.start
    -> existing orchestration/provider pipeline
    -> ordinary assistant message
    -> VoiceCallBridge -> realtime speech playback
    -> temporal Voice projection
```

The bridge adapts media events to existing orchestration commands. It is not a second turn engine.

## Deliverables

| ID  | Feature                  | Layer              | Actions                                                                           | Status   |
| --- | ------------------------ | ------------------ | --------------------------------------------------------------------------------- | -------- |
| 3.1 | Thread-owned start       | Contracts/server   | Authorize exact thread owner and derive project/provider/model placement          | Proposed |
| 3.2 | Final-utterance dispatch | Server             | Deduplicate final transcript and dispatch one ordinary `thread.turn.start`        | Proposed |
| 3.3 | Response bridge          | Server             | Observe the resulting ordinary turn and queue its final assistant text for speech | Proposed |
| 3.4 | Temporal projection      | Client runtime/web | Merge user transcript, thinking, assistant text, and input/output levels          | Proposed |
| 3.5 | Thread entry point       | Web                | Enable Call from the current thread without exposing Phase 4 behaviors            | Proposed |
| 3.6 | Vertical proof           | Integration        | Prove exact ownership, durable normal history, audio/text/presence coherence      | Proposed |

## Call bridge API

Add a mode-specific service rather than adding Call branches throughout Controller code:

```ts
interface VoiceCallBridge {
  activate(input: {
    session: ActiveVoiceSession & { owner: { kind: "thread" } };
    thread: CallableThreadSnapshot;
  }): Effect<void, VoiceCallError>;

  ingestFinalUtterance(input: {
    fence: VoiceSessionFence;
    transcriptItemId: VoiceTranscriptItemId;
    text: string;
  }): Effect<{ commandId: CommandId }, VoiceCallError>;
}
```

The bridge uses the orchestration engine's existing dispatch entry point. `transcriptItemId` maps deterministically to command/message identity so provider retries and duplicate final transcript events cannot create duplicate turns.

## Idle-thread eligibility

The server—not the button—must reject:

- a missing, deleted, archived, or managed-purpose thread;
- a thread outside the authenticated environment;
- a thread without a supported provider/model/voice placement;
- a thread with an active or already queued turn in this phase;
- an owner mismatch between the start request and later fenced events.

The UI may explain these states early, but server authorization remains decisive.

## Response behavior

For this slice, the complete final assistant message is the spoken text. This gives a deterministic fallback and avoids inventing a structured-response format prematurely. Phase 4 adds explicit spoken-segment metadata and richer activity projection.

The server associates the Voice command ID with the resulting turn, waits for the ordinary projected assistant final, then calls the existing transport speech append path. The temporal assistant text comes from the same payload that is queued for speech. Audio, text, and visual phase therefore cannot drift due to separate guesses.

## Files

### New

- `apps/server/src/voice/Services/VoiceCallBridge.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.test.ts`
- `packages/client-runtime/src/voice/voicePresentation.ts`
- `packages/client-runtime/src/voice/voicePresentation.test.ts`
- `apps/web/src/components/voice/VoiceCallContext.tsx`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `packages/contracts/src/rpc.ts`
- `packages/client-runtime/src/state/realtimeVoice.ts`
- `packages/client-runtime/src/state/realtimeVoice.test.ts`
- `apps/server/src/voice/Services/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/web/src/components/voice/VoiceSurface.tsx`
- `apps/web/src/components/voice/VoiceTranscript.tsx`
- `apps/web/src/components/voice/VoicePresence.tsx`
- `apps/web/src/components/chat/ChatComposer.voice.tsx`
- `apps/web/src/components/chat/ChatComposer.voice.test.tsx`

### Intentionally unchanged

- Controller ensure/target/action behavior.
- Ordinary thread decider/projector/provider reactor semantics.
- Approval and user-input UI.
- Mobile UI.
- The final production responsive layout.

## Implementation order

1. Add server tests proving a thread owner never invokes Controller ensure/handoff.
2. Implement exact-thread authorization and placement lookup.
3. Implement idempotent final-transcript-to-command mapping.
4. Observe the correlated ordinary turn's final assistant message and append identical text/speech to the media session.
5. Extend client state with the normalized temporal projection.
6. Enable the current-thread Call entry point only for an eligible idle thread.
7. Demonstrate the complete flow in the isolated browser environment.

## Focused verification

- Duplicate final transcript events produce one user message and one turn.
- The command targets the exact owner thread.
- No controller binding, action, mutation, or target changes.
- The user utterance and assistant response are durable ordinary messages.
- The exact assistant text drives both temporary display and speech append.
- Input amplitude drives listening/user-speaking presence; speech playback drives assistant-speaking presence.
- Ending the Call releases media once and leaves the ordinary thread intact.

Commands:

- `vp test run packages/contracts/src/realtimeVoice.test.ts packages/client-runtime/src/voice/voicePresentation.test.ts`
- `vp test run apps/server/src/voice/Layers/VoiceCallBridge.test.ts apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/components/chat/ChatComposer.voice.test.tsx`
- Integrated web: call an idle thread, speak one utterance, hear one response, and compare the Voice text with the durable thread messages.

## Exit criteria

- Call has exact ordinary-thread ownership in contracts, authorization, and runtime state.
- One final utterance creates exactly one normal thread turn.
- One final assistant payload drives durable text, temporal text, and speech.
- Controller infrastructure is untouched by the Call path.
