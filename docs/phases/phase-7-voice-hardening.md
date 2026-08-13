# Phase 7: Voice Operational and Performance Hardening

Status: proposed

## Overview and motivation

After the semantics and native surface exist, this slice proves the feature is respectful of user resources and resilient in the browser and packaged desktop. It also resolves the current partially implemented PCM fallback instead of carrying ambiguous support into release.

## User-visible result

Voice behaves predictably through permission denial/recovery, provider incompatibility, autoplay restrictions, WebSocket loss, server restart, backgrounding, degraded graphics, long sessions, and packaged desktop permission boundaries. Errors explain the next useful action and do not create duplicate sessions or threads.

## Release decision required

Choose one before implementation:

1. **WebRTC-only first release**: capability discovery explicitly reports WebRTC support and never advertises PCM fallback.
2. **Complete PCM support**: implement input append, output playback, backpressure, ordering, error propagation, and parity tests.

Recommendation: WebRTC-only unless a supported target cannot use it. A partial fallback is more complex and less safe than an explicit capability boundary.

## Deliverables

| ID  | Feature                              | Layer                | Actions                                                                           | Status   |
| --- | ------------------------------------ | -------------------- | --------------------------------------------------------------------------------- | -------- |
| 7.1 | Transport support decision           | Contracts/web/server | Remove or complete PCM; advertise exact capabilities                              | Proposed |
| 7.2 | Desktop main-window media permission | Desktop              | Allow local app audio capture with narrow origin/media checks and recovery        | Proposed |
| 7.3 | Failure matrix                       | Web/server           | Normalize permission, provider, auth, reconnect, stale owner, and autoplay states | Proposed |
| 7.4 | Observability                        | Server/web           | Add bounded lifecycle timings/counters without transcript/audio payloads          | Proposed |
| 7.5 | Renderer budgets                     | Web                  | Enforce active/ambient/background/reduced-motion resource policies                | Proposed |
| 7.6 | Long-session reliability             | Integration          | Exercise hours/generations without memory, lease, audio, or thread growth         | Proposed |

## Resource budgets

Budgets are acceptance criteria measured on one representative modern machine and one constrained/software-rendering profile:

| State                    | Target                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| Active visible presence  | Adaptive cap at 30 fps; no sustained main-thread long tasks caused by Voice |
| Ambient visible presence | At most 6 fps                                                               |
| Hidden/background        | Rendering paused; media follows platform background policy                  |
| Reduced motion           | Static or very low cadence with no audio-reactive rapid movement            |
| React commits            | No commits at audio sample/frame cadence                                    |
| GPU backing store        | Fixed bounded dimensions independent of transient panel pixel size          |
| Session memory           | No monotonic growth across 20 start/stop generations                        |
| Durable resources        | One open lease; bounded closed rows; bounded stable transport anchors       |

Exact CPU/GPU/memory numbers are recorded with the test hardware in the phase implementation report rather than invented in advance.

## Desktop permission architecture

The packaged app's main session currently preserves Electron defaults, while preview sessions have narrow local-audio rules. Add an equivalent narrow helper for the main application session:

- permit `media` only for audio-only requests;
- permit only the app's trusted local origins/partitions;
- do not install a catch-all handler that denies unrelated Electron permissions;
- cover deny, OS-level denial, subsequent permission grant, and retry without app restart;
- keep preview permission policy separate because it has different trust boundaries.

## Observability and privacy

Record only:

- owner kind, transport kind, phase transition, failure code;
- negotiation/reconnect/stop duration;
- generation count and cleanup outcome;
- render policy/degradation state.

Never record raw audio, partial transcript text, full final transcript, SDP, provider tokens, or controller credentials in generic logs/traces.

## Files

### New

- `apps/desktop/src/window/DesktopMediaPermissions.ts`
- `apps/desktop/src/window/DesktopMediaPermissions.test.ts`
- `apps/web/src/voice/voicePerformanceBudget.ts`
- `apps/web/src/voice/voicePerformanceBudget.test.ts`
- `apps/server/src/voice/VoiceDiagnostics.ts`
- `apps/server/src/voice/VoiceDiagnostics.test.ts`

### Modified

- `packages/contracts/src/realtimeVoice.ts`
- `packages/contracts/src/realtimeVoice.test.ts`
- `apps/server/src/voice/Layers/VoiceRuntimeGateway.ts`
- `apps/server/src/voice/Layers/VoiceRuntimeGateway.test.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.test.ts`
- `apps/server/src/ws.voice.integration.test.ts`
- `apps/web/src/voice/VoiceSessionController.ts`
- `apps/web/src/voice/VoiceSessionController.test.ts`
- `apps/web/src/voice/WebRtcVoiceTransport.ts`
- `apps/web/src/voice/WebRtcVoiceTransport.test.ts`
- `apps/web/src/voice/PcmVoiceTransport.ts` (delete for WebRTC-only or complete for PCM)
- `apps/web/src/voice/voiceBrowserSupport.ts`
- `apps/web/src/voice/voiceBrowserSupport.test.ts`
- `apps/web/src/voice/voiceErrors.ts`
- `apps/web/src/components/voice/VoicePresence.tsx`
- `apps/web/src/components/voice/voicePresenceRenderPolicy.ts`
- `apps/web/src/components/voice/voicePresenceRenderPolicy.test.ts`
- `apps/desktop/src/window/DesktopWindow.ts`
- `apps/desktop/src/window/DesktopWindow.test.ts`

### Intentionally unchanged

- Controller and Call product semantics.
- Ordinary thread orchestration.
- Mobile media implementation.
- Raw-content telemetry policy.

## Implementation order

1. Ratify and enforce the transport support decision.
2. Add desktop main-session permission helper and focused tests.
3. Complete normalized failure/retry behavior.
4. Add privacy-safe lifecycle diagnostics.
5. Add measurable render/session budgets and automated policy checks.
6. Run long-session, restart, packaged desktop, and constrained-renderer scenarios.

## Focused verification

- Permission denied, then granted, retries successfully without duplicate lease.
- Unsupported provider/model fails before mic acquisition.
- Autoplay failure offers a deliberate resume action without losing correlated text.
- WebSocket/server restart reconnects or ends honestly without replay.
- Packaged desktop main window allows trusted audio-only media and denies untrusted/video requests.
- Active/ambient/hidden/reduced-motion policies meet measured budgets.
- Twenty generations produce stable memory/anchor counts and no open leases after stop.
- Logs contain no transcript/audio/SDP/token material.

Commands:

- `vp test run apps/desktop/src/window/DesktopMediaPermissions.test.ts apps/desktop/src/window/DesktopWindow.test.ts`
- `vp test run apps/web/src/voice/VoiceSessionController.test.ts apps/web/src/voice/WebRtcVoiceTransport.test.ts apps/web/src/voice/voiceBrowserSupport.test.ts apps/web/src/voice/voicePerformanceBudget.test.ts`
- `vp test run apps/server/src/voice/VoiceDiagnostics.test.ts apps/server/src/voice/Layers/VoiceTransportCoordinator.test.ts apps/server/src/voice/Layers/VoiceRuntimeGateway.test.ts apps/server/src/ws.voice.integration.test.ts`
- Integrated browser and packaged-desktop runs with focused profiling and recorded hardware/budget results.

## Exit criteria

- Supported transports are explicit and complete.
- Browser and packaged desktop permission/recovery flows work.
- Lifecycle failures are bounded, actionable, and cleanup-safe.
- Rendering and session resource use meet measured budgets without hidden transcript/audio telemetry.
