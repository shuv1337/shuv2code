# Implementation Plan

## Current initiative: Native Voice

Status: proposed; discussion and review in progress

The Voice work is being integrated as a sequence of independently verifiable vertical slices. The source plan is [Native Voice: Vertical-Slice Plan](../.agents/plans/native-voice-vertical-slices.md). The current architecture audit is [Native Voice Integration Audit](project/voice-native-integration-audit.md).

## Product model

- **Controller** is an environment-scoped conversation that coordinates work across threads.
- **Call** is speech as a medium for one exact ordinary thread.
- **Transcription** is a provider operation, not a user-visible conversation.
- Managed controller and transport records may exist for lifecycle purposes, but they are not ordinary project threads and must not appear in user-facing lists.

## Delivery sequence

| Phase                                            | Deliverable                            | Demonstrable completion condition                                                                 | Status   |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| [1](phases/phase-1-voice-ownership-seam.md)      | Voice ownership seam                   | Current Controller remains functional and managed purposes are hidden consistently across clients | Proposed |
| [2](phases/phase-2-controller-without-ghosts.md) | Controller without ghosts              | Repeated lifecycle and recovery produce one live lease and no visible or leaked transport shells  | Proposed |
| [3](phases/phase-3-direct-thread-call.md)        | Direct Call on an idle thread          | Mic speech creates a normal turn on the exact thread; response text, audio, and presence agree    | Proposed |
| [4](phases/phase-4-call-thread-lifecycle.md)     | Call through the real thread lifecycle | Running turns, tools, approvals, interruption, navigation, archive, and reconnect remain coherent | Proposed |
| [5](phases/phase-5-controller-conversations.md)  | Controller conversation lifecycle      | Users can create, list, resume, and archive controller conversations                              | Proposed |
| [6](phases/phase-6-native-voice-surface.md)      | Native responsive Voice surface        | Real entry points and collapsed/panel layouts use the polished surface without relayout flicker   | Proposed |
| [7](phases/phase-7-voice-hardening.md)           | Operational and performance hardening  | Browser and packaged desktop meet lifecycle, permission, recovery, and resource budgets           | Proposed |
| [8](phases/phase-8-mobile-voice.md)              | Mobile parity                          | One mobile platform proves the same semantics with native media lifecycle; the other follows      | Proposed |

## Dependency flow

```text
1 Ownership seam
       |
2 Controller lifecycle safety
       |\
       |  5 Controller conversations
       |
3 Direct idle-thread Call
       |
4 Full thread lifecycle
       |\
       |  6 Native surface  <-- 5
       |         |
       |  7 Hardening
       |         |
       +------> 8 Mobile
```

## Why this fits the repository

| Concern                      | Existing owner                  | Proposed change                                                                                  |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Wire schemas                 | `packages/contracts`            | Add a discriminated session owner and mode-specific RPC schemas; no runtime logic                |
| Cross-client policy          | `packages/client-runtime`       | Centralize user-facing thread-purpose policy and normalized Voice presentation types             |
| Authorization and durability | `apps/server`                   | Route Controller and Call to their existing authoritative runtimes; extend lease cleanup         |
| Browser media orchestration  | `apps/web/src/voice`            | Extend the existing session controller and transports instead of creating another media stack    |
| Voice presentation           | `apps/web/src/components/voice` | Promote the existing surface/effect; presentation consumes state and does not own lifecycle      |
| Desktop permissions          | `apps/desktop`                  | Reuse the existing preview/session permission boundary and add recovery coverage                 |
| Mobile                       | `apps/mobile`                   | Adopt shared semantics after web/desktop behavior is stable; use platform-native media lifecycle |

## Global completion rules

Each phase must:

1. Keep the working product operable at the phase boundary.
2. Add focused tests in every changed layer.
3. Demonstrate the affected web behavior in one isolated environment using the repository testing workflow.
4. Demonstrate mobile behavior in one representative simulator when mobile files change.
5. Assert that no managed Voice infrastructure appears in user-facing selectors.
6. Avoid a compatibility bridge that has no named deletion phase.

## Deferred decisions

The plan deliberately leaves four decisions as review gates rather than burying guesses in implementation:

- active-turn utterance policy;
- called-thread archive/delete behavior;
- Controller restore semantics;
- PCM transport scope for the first native release.
