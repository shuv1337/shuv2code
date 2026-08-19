# Phase 2: Controller Without Ghosts

Status: proposed

## Overview and motivation

The current coordinator creates a new `voice-transport` projection thread for each browser generation and archives it only on a clean stop. That is the direct source of transport-thread spam and leaves crash/reload cleanup incomplete.

This slice makes the existing Controller operationally clean before Call depends on the same transport foundation.

## User-visible result

A user can repeatedly start, stop, reload, reconnect, lose the browser, or restart the server. Controller recovers or ends honestly, only one media session remains live, and no transport infrastructure appears anywhere as a conversation.

## Before and after

| Before                                                 | After                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| One projected transport thread per client generation   | One bounded internal transport anchor per environment/provider/project placement     |
| Startup reconciles only the current controller binding | Startup reconciles all open Voice leases in the environment                          |
| Browser loss can strand a durable lease                | Connection-owned cancellation plus stale-lease reaping                               |
| Clean stop is the primary archive path                 | Cleanup is idempotent across clean stop, failed negotiation, disconnect, and restart |

## Deliverables

| ID  | Feature                   | Layer                 | Actions                                                                             | Status   |
| --- | ------------------------- | --------------------- | ----------------------------------------------------------------------------------- | -------- |
| 2.1 | Stable transport anchor   | Server                | Reuse a deterministic hidden provider anchor instead of creating one per generation | Proposed |
| 2.2 | Complete lease repository | Persistence           | Add list-open, heartbeat/touch, close/fence, and retention operations               | Proposed |
| 2.3 | Connection cleanup        | WebSocket/server      | Stop owned sessions when the authenticated connection terminates                    | Proposed |
| 2.4 | Startup reaper            | Server startup        | Reconcile every stale environment lease and provider runtime                        | Proposed |
| 2.5 | Historical cleanup        | Migration/maintenance | Archive legacy `voice-transport` projections and bound closed rows                  | Proposed |
| 2.6 | Lifecycle harness         | Tests                 | Cover replay, conflict, failure, disconnect, restart, and zero-ghost invariants     | Proposed |

## Runtime design

Provider APIs currently require a thread-shaped runtime key. Avoid a provider rewrite in this slice. Replace generation-derived IDs with a stable internal anchor derived from environment plus provider placement:

```text
voice-transport:<environmentId>:<projectId>:<providerInstanceId>
```

The anchor remains `purpose = voice-transport`, is never user-facing, and is idempotently ensured. A project/provider change may create another anchor, but reconnects and generations do not. This bounds growth by actual runtime configuration rather than call count.

If later provider APIs support a dedicated realtime resource, the gateway may remove projection anchors without changing the public Voice contract.

## Lease lifecycle

```text
negotiating -> active -> closing -> closed
      |           |          |
      +--------> failed <-----+
      |           |
      +--------> fenced
```

- `openOrReplay` is idempotent for the same client session and generation.
- Another live lease in the environment returns a conflict; it is never silently replaced.
- A transcription test may replace only its own stale development lease under an explicit test policy.
- Provider start failure closes/fails the row and tears down the attempted provider session.
- WebSocket disconnect schedules immediate best-effort teardown and durable fencing.
- Startup enumerates every nonterminal row; process-local sessions cannot survive restart, so all are reconciled and fenced.
- Closed rows are retained only for a bounded diagnostic window; projection anchors are reused, not multiplied.

## Files

### New

- `apps/server/src/voice/VoiceTransportAnchor.ts`
- `apps/server/src/voice/VoiceTransportAnchor.test.ts`
- `apps/server/src/voice/VoiceTransportReaper.ts`
- `apps/server/src/voice/VoiceTransportReaper.test.ts`
- `apps/server/src/persistence/Migrations/044_VoiceTransportCleanup.ts`
- `apps/server/src/persistence/Migrations/044_VoiceTransportCleanup.test.ts`

### Modified

- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/persistence/Services/VoiceTransportSessions.ts`
- `apps/server/src/persistence/Layers/VoiceTransportSessions.ts`
- `apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `apps/server/src/voice/Services/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.ts`
- `apps/server/src/voice/Layers/VoiceTransportCoordinator.test.ts`
- `apps/server/src/voice/Services/VoiceRuntimeGateway.ts`
- `apps/server/src/voice/Layers/VoiceRuntimeGateway.ts`
- `apps/server/src/voice/Layers/VoiceRuntimeGateway.test.ts`
- `apps/server/src/serverRuntimeStartup.ts`
- `apps/server/src/serverRuntimeStartup.test.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/ws.voice.integration.test.ts`

### Intentionally unchanged

- Controller conversation identity and history.
- Controller action runner and mutation authorization.
- WebRTC signaling protocol.
- Voice visual surface.

## Implementation order

1. Write the coordinator lifecycle harness against current behavior so the generation-spam failure is visible.
2. Add repository enumeration and migration cleanup.
3. Introduce deterministic anchor selection and idempotent ensure.
4. Rework coordinator start/stop around environment-owned leases.
5. Add connection teardown and startup reaper.
6. Verify repeated real browser lifecycle with a database assertion.

## Focused verification

- Same-fence replay returns the existing active session.
- Conflicting live owner is rejected without creating an anchor or provider session.
- Failed negotiation leaves no open lease.
- Normal stop, browser disconnect, and server restart each leave zero open leases.
- Twenty reconnect generations reuse one transport anchor.
- Legacy generated transport projections are archived by migration.
- User-facing selectors contain zero managed Voice shells.

Commands:

- `vp test run apps/server/src/voice/Layers/VoiceTransportCoordinator.test.ts apps/server/src/voice/VoiceTransportAnchor.test.ts apps/server/src/voice/VoiceTransportReaper.test.ts`
- `vp test run apps/server/src/persistence/Migrations/044_VoiceTransportCleanup.test.ts apps/server/src/persistence/Layers/VoiceControlRepositories.test.ts`
- `vp test run apps/server/src/ws.voice.integration.test.ts apps/server/src/serverRuntimeStartup.test.ts`
- Integrated web: start/stop five times, reload while active, restart the isolated backend once, then inspect active/archived lists and lease rows.

## Exit criteria

- Session count cannot create unbounded projection-thread count.
- All terminal paths converge on the same idempotent cleanup.
- Startup handles all stale leases, not just the current Controller.
- Existing Controller still completes a spoken exchange.
