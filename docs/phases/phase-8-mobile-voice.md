# Phase 8: Mobile Voice Parity

Status: proposed

## Overview and motivation

Shared ownership, lifecycle, visibility, and presentation policy are cross-client from Phase 1 onward, but mobile has no Voice transport or surface. Building mobile after web/desktop stabilizes avoids independently discovering the same semantic mistakes while still preserving shared contracts.

## User-visible result

On one representative mobile platform, users can open Controller, call an exact thread, see the same temporal states, manage Controller conversations, mute/end, navigate away and return, and recover from interruptions using platform-native microphone/audio lifecycle. The second platform follows with the same shared semantics.

## Platform decision required

Choose the first representative platform based on available development hardware and release priority. On compatible macOS hosts, prefer iOS for the first vertical implementation; otherwise use Android. Do not implement both half-completely in parallel.

## Deliverables

| ID  | Feature                        | Layer                 | Actions                                                                                              | Status   |
| --- | ------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| 8.1 | Native media adapter           | Mobile/native         | Implement one platform's microphone, realtime transport, playback, interruption, and route lifecycle | Proposed |
| 8.2 | Shared session controller      | Client runtime/mobile | Reuse ownership/generation/reducer semantics behind a platform transport interface                   | Proposed |
| 8.3 | Mobile Voice surface           | Mobile                | Controller/Call modes, presence, temporal text, controls, collapsed presence                         | Proposed |
| 8.4 | Mobile entry points            | Mobile                | Thread composer Call, global Controller, active-session reopen                                       | Proposed |
| 8.5 | Background/interruption policy | Mobile                | Handle calls, audio route changes, app background, lock, and permission recovery                     | Proposed |
| 8.6 | Second platform                | Mobile/native         | Implement and verify parity after the representative slice passes                                    | Proposed |

## Architecture

Extend the existing transport interface rather than porting browser APIs into React Native:

```ts
interface RealtimeVoiceTransport {
  negotiate(input: VoiceNegotiationInput): Promise<VoiceNegotiationResult>;
  setMuted(muted: boolean): Promise<void>;
  stopPlayback(): Promise<void>;
  close(): Promise<void>;
  onInputLevel(listener: (level: number) => void): Unsubscribe;
  onOutputLevel(listener: (level: number) => void): Unsubscribe;
}
```

The shared session state machine owns generations, fences, transcripts, semantic activity, and exact cleanup. Browser and mobile supply transport/media implementations. Do not duplicate server RPC orchestration in mobile components.

The mobile presence may use a platform-appropriate shader/canvas implementation, but it must consume the same low-frequency semantic phase plus high-frequency amplitude refs and obey reduced-motion/background rules. Visual identity matters more than identical rendering technology.

## Mobile lifecycle rules

- Request microphone permission only after explicit start.
- Configure audio session/route immediately before capture and restore it on every terminal path.
- Incoming calls, route loss, and OS interruption stop or suspend media without replaying utterances.
- Background behavior is explicit per platform capability; no hidden capture.
- Returning from background reconciles server lease/generation before capture resumes.
- Navigation never retargets a thread-owned Call.
- Managed Voice purposes remain absent from all mobile thread lists.

## Files

Exact native filenames depend on the first platform and chosen media library; dependency selection is part of this phase's entry work.

### New

- `apps/mobile/src/features/voice/VoiceSurface.tsx`
- `apps/mobile/src/features/voice/VoiceSurface.test.tsx`
- `apps/mobile/src/features/voice/ControllerSurface.tsx`
- `apps/mobile/src/features/voice/CallSurface.tsx`
- `apps/mobile/src/features/voice/VoiceSessionProvider.tsx`
- `apps/mobile/src/features/voice/VoiceSessionController.ts`
- `apps/mobile/src/features/voice/VoiceSessionController.test.ts`
- `apps/mobile/src/features/voice/VoiceSessionTray.tsx`
- `apps/mobile/src/features/voice/VoicePresence.tsx`
- `apps/mobile/src/native/RealtimeVoiceTransport.native.ts`
- `apps/mobile/src/native/RealtimeVoiceTransport.ios.ts` (when iOS is first)
- `apps/mobile/src/native/RealtimeVoiceTransport.android.ts` (when Android is implemented)

### Modified

- `packages/client-runtime/src/voice/RealtimeVoiceTransport.ts`
- `packages/client-runtime/src/state/realtimeVoice.ts`
- `packages/client-runtime/src/state/realtimeVoice.test.ts`
- `apps/mobile/package.json`
- `apps/mobile/app.json` or the repository's Expo configuration source
- `apps/mobile/src/features/threads/ThreadComposer.tsx`
- `apps/mobile/src/features/threads/ThreadComposer.test.ts`
- `apps/mobile/src/features/home/homeThreadList.ts`
- `apps/mobile/src/features/home/homeThreadList.test.ts`
- `apps/mobile/src/features/threads/threadListV2.ts`
- `apps/mobile/src/features/threads/threadListV2.test.ts`
- the mobile authenticated/root navigation layout selected during implementation

### Intentionally unchanged

- Server ownership, Controller, Call, and lease semantics.
- Ordinary thread orchestration and approval APIs.
- Browser/Electron media adapters.
- A mobile-specific Voice backend.

## Implementation order

1. Select the representative platform and native media dependency using a small capability spike; record why.
2. Tighten the shared transport interface around browser and mobile needs without platform conditionals in state logic.
3. Implement native media/session lifecycle with unit/native tests.
4. Implement Controller vertical path and verify it on the simulator/device.
5. Implement exact-thread Call and thread lifecycle parity.
6. Add mobile surface, entry points, collapsed presence, and accessibility.
7. Exercise background, interruption, route change, permission denial/recovery, and reconnect.
8. Implement the second platform against the proven boundary.

## Focused verification

- Controller and Call owner schemas/state match web behavior.
- Final utterance and assistant response have the same durable/thread semantics as web.
- Permission denial/recovery does not strand a server lease.
- Audio interruption/background/foreground restores route and generation safely.
- Navigate away/back preserves exact Call owner.
- Reduced motion and screen-reader labels cover the presence and controls.
- No managed Voice shells appear in mobile lists.
- One representative simulator flow is run with the repository mobile testing skill after integration.

Commands are finalized after the native dependency is selected. The minimum focused set includes:

- `vp test run packages/client-runtime/src/state/realtimeVoice.test.ts`
- `vp test run apps/mobile/src/features/voice/VoiceSessionController.test.ts apps/mobile/src/features/voice/VoiceSurface.test.tsx`
- `vp test run apps/mobile/src/features/home/homeThreadList.test.ts apps/mobile/src/features/threads/threadListV2.test.ts apps/mobile/src/features/threads/ThreadComposer.test.ts`
- Representative iOS Simulator or Android Emulator integrated Voice flow using the repository mobile testing workflow.

## Exit criteria

- Mobile consumes the same product semantics and server APIs as web/desktop.
- Platform media lifecycle is native and cleanup-safe.
- One platform is complete and demonstrated before the second is started.
- No mobile-specific backend or duplicate thread lifecycle has been introduced.
