# Native Voice: Vertical-Slice Plan

Status: proposed for review

## Goal

Turn the current Voice lab and controller transport into a native shuv2code surface with two legible products:

- **Controller** is an environment-wide voice conversation used to inspect and coordinate threads.
- **Call** is a voice interaction with one exact, ordinary project thread. Its durable work belongs to that thread.

The implementation must preserve the architecture's existing ownership boundaries: contracts describe wire data, the server owns authorization and durable lifecycle, client-runtime owns cross-client policy, and each client owns presentation and platform media integration.

## Rules for every slice

1. It must end in one demonstrable user behavior.
2. It must include its contract, server behavior, client behavior, cleanup, and focused tests when those layers are involved.
3. It must not add a second source of truth for threads, turns, approvals, transcripts, or connection state.
4. It must be safe to stop after the slice. Later slices extend it; they do not repair an intentionally incomplete lifecycle.
5. Managed transport infrastructure must never appear in user-facing thread lists.
6. Mode selection and media-session state are different state machines.
7. Only one media owner may capture the microphone for an environment at a time.

## Proposed product invariants

### Controller

- Scope: environment-wide.
- Durable identity: a managed controller conversation selected by one environment binding.
- Context: may inspect or target multiple ordinary threads through explicit server tools.
- Transcript: visually distinct from ordinary thread content; the existing orange voice language remains appropriate.
- Lifecycle: start a new controller, list previous controllers, resume one, and archive one.

### Call

- Scope: exactly one ordinary thread.
- Durable identity: the ordinary thread ID; no controller shell and no handoff.
- Context: the thread's normal conversation, approvals, user input, tools, and queueing rules.
- Transcript: only temporally relevant speech and activity appears in the Voice surface. Durable user and assistant content remains in the normal thread.
- Navigation: leaving the thread does not silently retarget the call. The active call becomes a pinned/collapsed global presence until the user returns or ends it.
- Interruption: barge-in stops current speech playback. It does not implicitly cancel tools. The new utterance follows the thread's normal steer/queue behavior.

## Slice map

| Slice                                     | User-visible proof                                                                                                         | Depends on             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Ownership seam                         | Existing Controller still works; managed infrastructure is invisible on web and mobile                                     | Current implementation |
| 2. Controller without ghosts              | Repeated start, stop, reload, reconnect, and crash recovery produce one session and no transport-thread debris             | 1                      |
| 3. Direct Call on an idle thread          | From a thread, start a call; speech becomes a normal user turn; the answer is spoken and shown temporarily                 | 1, 2                   |
| 4. Call through the real thread lifecycle | Calls behave correctly during running turns, tools, approvals, barge-in, navigation, archive, and reconnect                | 3                      |
| 5. Controller conversations               | Start, list, resume, and archive Controller conversations without exposing managed threads in the sidebar                  | 2                      |
| 6. Native Voice surface                   | The polished responsive Voice panel, collapsed presence, entry points, and no-flicker canvas replace lab-only presentation | 3, 4, 5                |
| 7. Operational hardening                  | Packaged desktop and browser survive provider failure, restart, degraded graphics, and long sessions within budgets        | 6                      |
| 8. Mobile parity                          | iOS/Android expose the same Controller/Call model using native media lifecycle and permissions                             | 4, 5, 7                |

## Review gates

The following decisions must be ratified before the named slice begins:

- Before Slice 3: whether an utterance during an active turn defaults to steer, queue, or the existing thread preference.
- Before Slice 4: whether archiving/deleting the called thread ends the call immediately or asks for confirmation.
- Before Slice 5: whether restoring a Controller makes it the active environment binding immediately.
- Before Slice 7: whether PCM is a release requirement or WebRTC is the supported first-release transport.
- Before Slice 8: which mobile platform is the first representative implementation.

## Architectural shape

The minimum new semantic seam is a discriminated session owner:

```ts
type VoiceSessionOwner =
  | { kind: "controller"; controllerThreadId: ThreadId }
  | { kind: "thread"; threadId: ThreadId }
  | { kind: "transcription"; requestId: string };
```

This replaces the current assumption that every voice session is owned by a controller thread. It is not a new thread model. Ordinary thread Calls continue through the existing thread turn pipeline; Controller continues through the existing controller runtime; transcription-only remains an isolated provider operation.

The server remains authoritative for session ownership, authorization, lease fencing, and cleanup. `VoiceSessionController` remains the browser orchestration boundary. `VoiceSurface` renders a normalized presentation model and does not infer backend semantics from visual mode.

## Explicit non-goals

- No separate “voice thread” type for Calls.
- No duplicated call-only turn engine.
- No second approval or user-input system.
- No WebRTC rewrite in the product slices.
- No Three.js dependency for the presence effect.
- No mobile implementation before the web/desktop lifecycle is stable.
- No attempt to expose transport projection threads as user content.
