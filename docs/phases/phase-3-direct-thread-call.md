# Phase 3: Direct Call on an Idle Thread

Status: in progress

## Progress

- Exact ordinary-thread ownership is now authorized on the server and retained through the durable environment lease, media fence, event subscription, and stop request.
- Production Call starts the existing microphone/WebRTC-or-PCM stack from the current thread without ensuring a Controller, setting a Controller target, or accepting a Controller handoff.
- Call startup resolves project, provider, model, runtime mode, archived/deleted state, and idle-turn eligibility from the authoritative thread projection.
- The retained dev database upgrades through migration 044 instead of resetting owner-era data; focused migration coverage preserves the compatibility anchor required by the existing RPC fence.
- Integrated web verification proved `Start call` -> Listening -> End call on an ordinary thread and confirmed the resulting transport lease was closed and its hidden transport projection archived.
- Call starts the realtime model with a bounded projection of the exact ordinary thread and a mode prompt. Realtime owns the low-latency conversational front channel and can answer directly from that context.
- Realtime has priority inside Call. A completed conversational user/assistant exchange is appended to the exact ordinary thread as one completed model turn without starting a second model response. Only an explicit realtime delegation starts or steers deeper thread-model work for tools or substantial text, and that work never stops the live Call.
- Voice-call provenance carries the bounded active call transcript as hidden, untrusted provider context. The ordinary thread model is told that it is serving an active voice call and avoids repeating an acknowledgement the user already heard.
- The authenticated `voice_speak` MCP tool lets that ordinary thread model select concise progress or result segments for live speech while keeping code, logs, and detailed prose in the durable thread. One tool call drives provider playback, the temporal assistant transcript, and an exact durable assistant message in the active ordinary turn.
- Realtime is explicitly instructed not to delegate questions it can answer from the supplied exact-thread context. Delegated turns must return a compact result through `voice_speak` before completing, so durable work extends the live Call instead of replacing it with a text-only answer.
- Thread-originated spoken transcripts carry an explicit source marker. The web client accepts those events even after provider data-channel transcription becomes authoritative, keeping the heard result, temporal Call text, and presence response coherent.
- Production Call now feeds live microphone and remote WebRTC energy into the persistent presence shader. Provider V3 `input_transcript.added` chunks accumulate into one temporal utterance even when each chunk has a different item identity. Provider transcript completion closes a conversational exchange; `delegation.created` is authoritative only when realtime explicitly requests deeper thread work. Silence, item changes, individual chunks, and speaker transitions never create thread turns.

## Overview and motivation

This is the first new product slice. It makes Call true at the architecture boundary: the session is owned by one exact ordinary thread and realtime is that thread's low-latency conversational model while the Call is active. Completed realtime exchanges become ordinary thread history. The ordinary thread model runs only when realtime delegates deeper work, and can then control which compact parts of that work are spoken without flattening its full response into call audio.

The slice is intentionally limited to an idle, callable thread. Running-turn behavior, tools/approvals, navigation, and barge-in are Phase 4.

## User-visible result

From an idle project thread, the user chooses **Call this thread**, starts the microphone, speaks, and sees the current utterance temporarily. Realtime answers from exact-thread context without waiting, and the completed exchange appears in that thread as one model turn. If realtime delegates deeper work, the existing thread model starts or is steered while Call remains connected and realtime remains the live conversational surface.

No controller is ensured. No controller target is set. No controller action is created.

## End-to-end flow

```text
ordinary thread history --bounded--> realtime Call context
mic -> existing WebRTC transport -> temporal user transcript
    -> realtime answer -> provider audio + temporal assistant text
    -> completed user/assistant exchange -> one durable realtime model turn

explicit delegation -> VoiceCallBridge -> thread.turn.start or thread.turn.steer
    -> existing orchestration/provider pipeline with hidden voice-mode context
    -> voice_speak(chosen segment) -> provider audio + temporal text + exact durable speech message
    -> normal detailed assistant output -> durable ordinary thread
    -> Call remains connected throughout
```

The bridge adapts media events to existing orchestration commands. It is not a second turn engine.

## Deliverables

| ID  | Feature               | Layer              | Actions                                                                      | Status   |
| --- | --------------------- | ------------------ | ---------------------------------------------------------------------------- | -------- |
| 3.1 | Thread-owned start    | Contracts/server   | Authorize exact thread owner and derive project/provider/model placement     | Complete |
| 3.2 | Realtime turn bridge  | Server             | Append each finalized realtime exchange as one exact-thread completed turn   | Complete |
| 3.3 | Delegated work bridge | Server/MCP         | Start deeper work only on delegation and let it emit chosen spoken segments  | Complete |
| 3.4 | Temporal projection   | Client runtime/web | Merge user transcript, thinking, assistant text, and input/output levels     | Partial  |
| 3.5 | Thread entry point    | Web                | Enable Call from the current thread without exposing Phase 4 behaviors       | Complete |
| 3.6 | Vertical proof        | Integration        | Prove exact ownership, durable normal history, audio/text/presence coherence | Proposed |

## Call bridge API

Add a mode-specific service rather than adding Call branches throughout Controller code:

```ts
interface VoiceCallBridge {
  ingestTranscript(input: {
    session: ActiveVoiceSession;
    itemId: VoiceTranscriptItemId;
    role: "user" | "assistant";
    text: string;
    occurredAt: IsoDateTime;
    activeTranscript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  }): Effect<{ accepted: boolean; commandId?: CommandId }, VoiceControllerError>;

  delegateUtterance(input: {
    session: ActiveVoiceSession;
    itemId: VoiceTranscriptItemId;
    text: string;
    occurredAt: IsoDateTime;
    activeTranscript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  }): Effect<{ accepted: boolean; commandId?: CommandId }, VoiceControllerError>;
}
```

The bridge uses the orchestration engine's existing dispatch entry point. A completed realtime exchange maps deterministically to one `thread.voice.exchange.append` event containing the user and realtime-assistant messages under one completed turn identity; it does not invoke the provider command reactor. An explicit delegation maps deterministically to `thread.turn.start`, or `thread.turn.steer` when deeper work is already running. Authenticated command provenance carries the voice-mode marker and bounded call transcript to delegated work without creating a second user-visible message.

## Idle-thread eligibility

The server—not the button—must reject:

- a missing, deleted, archived, or managed-purpose thread;
- a thread outside the authenticated environment;
- a thread without a supported provider/model/voice placement;
- a thread with an active or already queued turn in this phase;
- an owner mismatch between the start request and later fenced events.

The UI may explain these states early, but server authorization remains decisive.

## Response behavior

Realtime speech uses the provider's native low-latency response path and owns ordinary conversation. Questions answerable from supplied exact-thread context remain on this path; checking or discussing that context is not by itself a reason to delegate. Once both sides are final, that exchange is appended as the durable model turn. Only delegated work receives hidden voice-mode instructions and an authenticated `voice_speak` tool. The deeper model must call it with a concise, independently understandable result before completing, and may also use it for progress or clarification; its ordinary response remains free to contain code, logs, and detailed prose.

`voice_speak` resolves the active session by authenticated environment plus exact thread owner and fails closed when no matching Call exists. Its single normalized payload is projected as a distinct assistant message in the active ordinary turn, emitted as a thread-originated temporal assistant transcript, and appended to provider speech. The text in the thread, the visible Call transcript, and the heard text therefore share one source. The additive `thread.voice-speech-appended` event deliberately does not settle the turn or replace its detailed assistant message. Provider data-channel transcription remains authoritative for realtime utterances, while the explicit source marker prevents it from suppressing later thread-originated speech. The tool does not create another turn engine or a second persistent conversation.

Durable Call messages carry an explicit `voice` modality through the projection table, thread snapshot, live thread subscription, and client reducer. In a delegated turn, spoken narration is supporting Call history and remains available inside `Worked for…` with the other activity; the provider's formatted durable text is the sole visible terminal result. A delayed Voice projection must never replace that durable answer or push it into the work fold, and the canonical answer renders after all supporting activity even when its streaming message was created earlier. A voice-only realtime exchange still renders its spoken assistant message as the terminal result because no separate durable text answer exists. This is semantic metadata rather than message-id inference. The projection migration backfills the namespaced prototype rows once, and the web thread-cache schema version advances with it because a projection-only migration does not advance the orchestration event cursor.

## Files

### New

- `apps/server/src/voice/Services/VoiceCallBridge.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.ts`
- `apps/server/src/voice/Layers/VoiceCallBridge.test.ts`
- `apps/server/src/mcp/toolkits/voice/tools.ts`
- `apps/server/src/mcp/toolkits/voice/handlers.ts`
- `apps/server/src/mcp/toolkits/voice/handlers.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.voice.test.ts`
- `apps/web/src/components/voice/useVoiceActivity.ts`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/rpc.ts`
- `packages/client-runtime/src/state/realtimeVoice.ts`
- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/McpInvocationContext.ts`
- `apps/server/src/mcp/McpSessionRegistry.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`
- `apps/server/src/persistence/Migrations/045_ProjectionThreadMessageModality.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/voice/Services/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Services/VoiceControllerService.ts`
- `apps/server/src/voice/Services/VoiceRuntimeGateway.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceControllerService.ts`
- `apps/server/src/voice/Layers/VoiceControllerActionRunner.ts`
- `apps/server/src/voice/Layers/VoiceRuntimeGateway.ts`
- `apps/server/src/voice/VoiceHandoffRequest.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/web/src/connection/storage.ts`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/components/voice/VoiceSurface.tsx`
- `apps/web/src/components/voice/VoiceTranscript.tsx`
- `apps/web/src/components/voice/VoicePresence.tsx`
- `apps/web/src/components/chat/ChatComposer.voice.tsx`
- `apps/web/src/components/chat/ChatComposer.voice.test.tsx`

### Intentionally unchanged

- Controller ensure/target/action behavior.
- Existing ordinary provider-turn semantics; realtime exchanges use one additive event and projection path.
- Approval and user-input UI.
- Mobile UI.
- The final production responsive layout.

## Implementation order

1. Add server tests proving a thread owner never invokes Controller ensure/handoff. ✅
2. Implement exact-thread authorization and placement lookup. ✅
3. Implement idempotent finalized-exchange-to-completed-turn mapping and suppress duplicate handoff dispatch. ✅
4. Hydrate realtime with bounded exact-thread context for its authoritative low-latency response. ✅
5. Inject hidden voice-mode context into delegated ordinary turns and add authenticated model-controlled speech. ✅
6. Extend client state with the normalized temporal projection. ◐
7. Enable the current-thread Call entry point only for an eligible idle thread. ✅
8. Demonstrate the complete hybrid response flow in the isolated browser environment. ◐

## Focused verification

- Duplicate transcript completion events produce one realtime user/assistant exchange and one completed model turn; ordinary model generation is not started for that exchange.
- Provisional V3 chunks with changing item identities accumulate only in the temporal transcript. Explicit delegation alone starts or steers deeper work, never routes through Controller, and never tears down the realtime Call.
- Rendering or starting Call mode performs no Controller-history read and no Controller-target mutation; the called thread's presentation identity is never interpreted as a Controller identity.
- The command targets the exact owner thread.
- No controller binding, action, mutation, or target changes.
- Finalized user text and realtime response are durable messages in one completed turn; no second provider response is started.
- One `voice_speak` payload drives temporary display, provider speech, and one exact durable assistant message without changing turn completion.
- Input amplitude drives listening/user-speaking presence; speech playback drives assistant-speaking presence.
- Ending the Call releases media once and leaves the ordinary thread intact.

Commands:

- `vp test run packages/contracts/src/realtimeVoice.test.ts packages/client-runtime/src/voice/voicePresentation.test.ts`
- `vp test run apps/server/src/voice/Layers/VoiceCallBridge.test.ts apps/server/src/ws.voice.integration.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/components/chat/ChatComposer.voice.test.tsx`
- Integrated web: call an idle thread, speak one utterance, hear one response, and compare the Voice text with the durable thread messages.

## Exit criteria

- Call has exact ordinary-thread ownership in contracts, authorization, and runtime state.
- Realtime receives bounded exact-thread context and remains the authoritative conversational model during Call.
- One finalized realtime user/assistant exchange creates exactly one completed normal thread turn without starting the ordinary provider model.
- Only explicit delegation starts or steers deeper work; that work can control spoken segments while Call stays connected.
- Controller infrastructure is untouched by the Call path.
