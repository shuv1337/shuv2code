import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@shuv2code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { VoiceControllerActionRepositoryLive } from "./VoiceControllerActions.ts";
import { VoiceControllerBindingRepositoryLive } from "./VoiceControllerBindings.ts";
import { VoiceControllerMutationRepositoryLive } from "./VoiceControllerMutations.ts";
import { VoiceTransportSessionRepositoryLive } from "./VoiceTransportSessions.ts";
import { VoiceControllerActionRepository } from "../Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../Services/VoiceControllerMutations.ts";
import { VoiceTransportSessionRepository } from "../Services/VoiceTransportSessions.ts";

const repositories = Layer.mergeAll(
  VoiceControllerBindingRepositoryLive,
  VoiceTransportSessionRepositoryLive,
  VoiceControllerActionRepositoryLive,
  VoiceControllerMutationRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const layer = it.layer(repositories);

const environmentId = EnvironmentId.make("environment-1");
const controllerThreadId = ThreadId.make("controller-1");
const hostProjectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = "2026-07-30T00:00:00.000Z";

const resetVoiceRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_controller_mutations`;
  yield* sql`DELETE FROM voice_controller_actions`;
  yield* sql`DELETE FROM voice_transport_sessions`;
  yield* sql`DELETE FROM voice_controller_bindings`;
  yield* sql`DELETE FROM voice_controller_binding_generations`;
});

const reserveBinding = Effect.gen(function* () {
  const bindings = yield* VoiceControllerBindingRepository;
  const reservation = yield* bindings.reserve({
    environmentId,
    controllerThreadId,
    hostProjectId,
    providerInstanceId,
    authorizedRuntimeCeiling: "approval-required",
    bindingGeneration: 1,
    controlEpoch: 0,
    createdAt: now,
  });
  assert.strictEqual(reservation._tag, "created");
  assert.isTrue(
    yield* bindings.compareAndSetState({
      environmentId,
      expectedControllerThreadId: reservation.binding.controllerThreadId,
      expectedBindingGeneration: reservation.binding.bindingGeneration,
      expectedState: "provisioning",
      nextState: "active",
      expectedControlEpoch: 0,
      updatedAt: now,
    }),
  );
});

const openTransport = Effect.gen(function* () {
  const transports = yield* VoiceTransportSessionRepository;
  const opened = yield* transports.openOrReplay({
    transportSessionId: "transport-1",
    environmentId,
    controllerThreadId,
    transportThreadId: ThreadId.make("transport-thread-1"),
    runtimeInstanceId: "transport-runtime-1",
    generation: 1,
    createdAt: now,
  });
  assert.strictEqual(opened._tag, "created");
  assert.isTrue(
    yield* transports.activate({
      transportSessionId: "transport-1",
      generation: 1,
      runtimeInstanceId: "transport-runtime-1",
      realtimeSessionId: "realtime-1",
      updatedAt: now,
    }),
  );
});

const createBoundAction = (voiceActionId: string, handoffId: string, turnId: string) =>
  Effect.gen(function* () {
    const actions = yield* VoiceControllerActionRepository;
    const created = yield* actions.createOrReplay({
      voiceActionId,
      environmentId,
      controllerThreadId,
      transportSessionId: "transport-1",
      transportRuntimeInstanceId: "transport-runtime-1",
      transportGeneration: 1,
      handoffId,
      handoffItemId: `${handoffId}-item`,
      clientUserMessageId: voiceActionId,
      controllerRuntimeInstanceId: "controller-runtime-1",
      createdAt: now,
    });
    assert.strictEqual(created._tag, "created");
    const bound = yield* actions.bindControllerTurn({
      voiceActionId,
      controllerProviderSessionId: "provider-session-1",
      controllerProviderTurnId: TurnId.make(turnId),
      boundAt: now,
    });
    assert.strictEqual(bound._tag, "bound");
  });

layer("VoiceControlRepositories", (it) => {
  it.effect("reserves one controller and rotates the control epoch atomically", () =>
    Effect.gen(function* () {
      const bindings = yield* VoiceControllerBindingRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;

      const replay = yield* bindings.reserve({
        environmentId,
        controllerThreadId,
        hostProjectId,
        providerInstanceId,
        authorizedRuntimeCeiling: "approval-required",
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      assert.strictEqual(replay._tag, "existing");

      const conflict = yield* bindings.reserve({
        environmentId,
        controllerThreadId: ThreadId.make("controller-other"),
        hostProjectId,
        providerInstanceId,
        authorizedRuntimeCeiling: "approval-required",
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      assert.strictEqual(conflict._tag, "conflict");

      const incremented = yield* bindings.incrementControlEpoch({
        environmentId,
        expectedControlEpoch: 0,
        updatedAt: now,
      });
      assert.deepStrictEqual(incremented, { _tag: "incremented", controlEpoch: 1 });
      assert.deepStrictEqual(
        yield* bindings.incrementControlEpoch({
          environmentId,
          expectedControlEpoch: 0,
          updatedAt: now,
        }),
        { _tag: "conflict" },
      );

      const targetThreadId = ThreadId.make("target-1");
      assert.isTrue(
        yield* bindings.setActiveTarget({
          environmentId,
          controllerThreadId,
          expectedControlEpoch: 1,
          activeTargetThreadId: targetThreadId,
          updatedAt: now,
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).activeTargetThreadId,
        targetThreadId,
      );
      assert.isFalse(
        yield* bindings.clearActiveTargetIfMatches({
          environmentId,
          controllerThreadId,
          expectedControlEpoch: 1,
          expectedActiveTargetThreadId: ThreadId.make("different-target"),
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* bindings.clearActiveTargetIfMatches({
          environmentId,
          controllerThreadId,
          expectedControlEpoch: 1,
          expectedActiveTargetThreadId: targetThreadId,
          updatedAt: now,
        }),
      );
      assert.isNull(
        Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).activeTargetThreadId,
      );

      const activeBinding = Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId));
      assert.isTrue(
        yield* bindings.compareAndSetState({
          environmentId,
          expectedControllerThreadId: controllerThreadId,
          expectedBindingGeneration: activeBinding.bindingGeneration,
          expectedState: "active",
          nextState: "dormant",
          expectedControlEpoch: 1,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* bindings.setActiveTarget({
          environmentId,
          controllerThreadId,
          expectedControlEpoch: 1,
          activeTargetThreadId: targetThreadId,
          updatedAt: now,
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).activeTargetThreadId,
        targetThreadId,
      );
    }),
  );

  it.effect("does not reuse a controller binding claimed by reset", () =>
    Effect.gen(function* () {
      const bindings = yield* VoiceControllerBindingRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;

      const resetting = Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId));
      assert.isTrue(
        yield* bindings.compareAndSetState({
          environmentId,
          expectedControllerThreadId: resetting.controllerThreadId,
          expectedBindingGeneration: resetting.bindingGeneration,
          expectedState: "active",
          nextState: "resetting",
          expectedControlEpoch: resetting.controlEpoch,
          updatedAt: now,
        }),
      );

      const reservation = yield* bindings.reserve({
        environmentId,
        controllerThreadId: resetting.controllerThreadId,
        hostProjectId,
        providerInstanceId,
        authorizedRuntimeCeiling: "approval-required",
        bindingGeneration: resetting.bindingGeneration,
        controlEpoch: resetting.controlEpoch,
        createdAt: now,
      });

      assert.strictEqual(reservation._tag, "conflict");
      assert.strictEqual(reservation.binding.state, "resetting");
    }),
  );

  it.effect("binds one handoff to one exact controller turn and fences stale generations", () =>
    Effect.gen(function* () {
      const actions = yield* VoiceControllerActionRepository;
      const transports = yield* VoiceTransportSessionRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("action-1", "handoff-1", "turn-1");

      const resolved = yield* actions.resolveOpenByControllerTurn({
        controllerThreadId,
        controllerRuntimeInstanceId: "controller-runtime-1",
        controllerProviderSessionId: "provider-session-1",
        controllerProviderTurnId: TurnId.make("turn-1"),
      });
      assert.strictEqual(Option.getOrNull(resolved)?.voiceActionId, "action-1");

      const wrongRuntime = yield* actions.resolveOpenByControllerTurn({
        controllerThreadId,
        controllerRuntimeInstanceId: "controller-runtime-other",
        controllerProviderSessionId: "provider-session-1",
        controllerProviderTurnId: TurnId.make("turn-1"),
      });
      assert.isTrue(Option.isNone(wrongRuntime));

      const duplicateHandoff = yield* actions.createOrReplay({
        voiceActionId: "action-other",
        environmentId,
        controllerThreadId,
        transportSessionId: "transport-1",
        transportRuntimeInstanceId: "transport-runtime-1",
        transportGeneration: 1,
        handoffId: "handoff-1",
        handoffItemId: "handoff-1-item",
        clientUserMessageId: "action-other",
        controllerRuntimeInstanceId: "controller-runtime-1",
        createdAt: now,
      });
      assert.strictEqual(duplicateHandoff._tag, "conflict");
      assert.deepStrictEqual(
        (yield* actions.listByTransportSessionId!("transport-1")).map(
          (action) => action.voiceActionId,
        ),
        ["action-1"],
      );
      assert.deepStrictEqual(
        (yield* actions.listRecentByControllerThreadId!(controllerThreadId)).map(
          (action) => action.voiceActionId,
        ),
        ["action-1"],
      );

      assert.strictEqual(
        yield* actions.fenceTransportGeneration({
          transportSessionId: "transport-1",
          throughGeneration: 1,
          closedAt: now,
        }),
        1,
      );
      assert.strictEqual(
        yield* transports.fenceGeneration({
          controllerThreadId,
          throughGeneration: 1,
          fencedAt: now,
        }),
        1,
      );
      const replacementTransport = yield* transports.openOrReplay({
        transportSessionId: "different-client:1",
        environmentId,
        controllerThreadId,
        transportThreadId: ThreadId.make("transport-thread-2"),
        runtimeInstanceId: "transport-runtime-2",
        generation: 1,
        createdAt: "2026-07-30T00:01:00.000Z",
      });
      assert.strictEqual(replacementTransport._tag, "created");
      assert.isTrue(
        Option.isNone(
          yield* actions.resolveOpenByControllerTurn({
            controllerThreadId,
            controllerRuntimeInstanceId: "controller-runtime-1",
            controllerProviderSessionId: "provider-session-1",
            controllerProviderTurnId: TurnId.make("turn-1"),
          }),
        ),
      );

      const bindings = yield* VoiceControllerBindingRepository;
      const beforeReset = Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId));
      assert.isTrue(
        yield* bindings.compareAndSetState({
          environmentId,
          expectedControllerThreadId: beforeReset.controllerThreadId,
          expectedBindingGeneration: beforeReset.bindingGeneration,
          expectedState: "active",
          nextState: "resetting",
          expectedControlEpoch: 0,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* bindings.deleteResetting({
          environmentId,
          expectedControllerThreadId: beforeReset.controllerThreadId,
          expectedBindingGeneration: beforeReset.bindingGeneration,
        }),
      );
      const replacement = yield* bindings.reserve({
        environmentId,
        controllerThreadId: ThreadId.make("controller-2"),
        hostProjectId,
        providerInstanceId,
        authorizedRuntimeCeiling: "approval-required",
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      assert.strictEqual(replacement._tag, "created");
      assert.strictEqual(replacement.binding.bindingGeneration, beforeReset.bindingGeneration + 1);
      assert.isTrue(
        yield* bindings.compareAndSetState({
          environmentId,
          expectedControllerThreadId: replacement.binding.controllerThreadId,
          expectedBindingGeneration: replacement.binding.bindingGeneration,
          expectedState: "provisioning",
          nextState: "active",
          expectedControlEpoch: replacement.binding.controlEpoch,
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* bindings.compareAndSetState({
          environmentId,
          expectedControllerThreadId: beforeReset.controllerThreadId,
          expectedBindingGeneration: beforeReset.bindingGeneration,
          expectedState: "active",
          nextState: "resetting",
          expectedControlEpoch: beforeReset.controlEpoch,
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* bindings.deleteResetting({
          environmentId,
          expectedControllerThreadId: beforeReset.controllerThreadId,
          expectedBindingGeneration: beforeReset.bindingGeneration,
        }),
      );
      const afterStaleReset = Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId));
      assert.strictEqual(
        afterStaleReset.controllerThreadId,
        replacement.binding.controllerThreadId,
      );
      assert.strictEqual(afterStaleReset.state, "active");
    }),
  );

  it.effect("enforces one mutation per action and the pre-dispatch cancellation boundary", () =>
    Effect.gen(function* () {
      const mutations = yield* VoiceControllerMutationRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("action-1", "handoff-1", "turn-1");

      const claimed = yield* mutations.claimOrReplay({
        voiceActionId: "action-1",
        mutationKey: "mutation-1",
        toolName: "thread_send",
        semanticSlot: "send:target-1",
        canonicalRequestHash: "hash-1",
        operationId: "operation-1",
        providerCreationId: null,
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      assert.strictEqual(claimed._tag, "claimed");
      assert.strictEqual(
        (yield* mutations.claimOrReplay({
          voiceActionId: "action-1",
          mutationKey: "mutation-1",
          toolName: "thread_send",
          semanticSlot: "send:target-1",
          canonicalRequestHash: "hash-1",
          operationId: "operation-1",
          providerCreationId: null,
          bindingGeneration: 1,
          controlEpoch: 0,
          createdAt: now,
        }))._tag,
        "replay",
      );
      assert.strictEqual(
        (yield* mutations.claimOrReplay({
          voiceActionId: "action-1",
          mutationKey: "mutation-1",
          toolName: "thread_send",
          semanticSlot: "send:target-1",
          canonicalRequestHash: "different-hash",
          operationId: "operation-1",
          providerCreationId: null,
          bindingGeneration: 1,
          controlEpoch: 0,
          createdAt: now,
        }))._tag,
        "conflict",
      );
      assert.strictEqual(
        (yield* mutations.claimOrReplay({
          voiceActionId: "action-1",
          mutationKey: "mutation-1",
          toolName: "thread_send",
          semanticSlot: "send:other-target",
          canonicalRequestHash: "hash-1",
          operationId: "operation-1",
          providerCreationId: null,
          bindingGeneration: 1,
          controlEpoch: 0,
          createdAt: now,
        }))._tag,
        "conflict",
      );
      assert.strictEqual(
        Option.getOrThrow(yield* mutations.getByOperationId("operation-1")).voiceActionId,
        "action-1",
      );
      assert.strictEqual(
        (yield* mutations.claimOrReplay({
          voiceActionId: "action-1",
          mutationKey: "mutation-2",
          toolName: "thread_interrupt",
          semanticSlot: "interrupt:target-1:turn-1",
          canonicalRequestHash: "hash-2",
          operationId: "operation-2",
          providerCreationId: null,
          bindingGeneration: 1,
          controlEpoch: 0,
          createdAt: now,
        }))._tag,
        "conflict",
      );

      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "action-1",
          claimOwner: "worker-1",
          claimExpiresAt: "2026-07-30T00:01:00.000Z",
          claimedAt: now,
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isFalse(
        yield* mutations.cancelNeverDispatchedByPolicy({
          voiceActionId: "action-1",
          cancelledAt: now,
          sanitizedOutcome: "control_disabled",
        }),
      );
      assert.isTrue(
        yield* mutations.releaseClaim({
          voiceActionId: "action-1",
          claimOwner: "worker-1",
          mayHavePersistedIntents: false,
          updatedAt: now,
        }),
      );
      assert.isTrue(
        yield* mutations.cancelNeverDispatchedByPolicy({
          voiceActionId: "action-1",
          cancelledAt: now,
          sanitizedOutcome: "control_disabled",
        }),
      );
    }),
  );

  it.effect("bulk policy cancellation includes durable rows absent from memory", () =>
    Effect.gen(function* () {
      const mutations = yield* VoiceControllerMutationRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("persisted-action", "persisted-handoff", "persisted-turn");
      yield* mutations.claimOrReplay({
        voiceActionId: "persisted-action",
        mutationKey: "persisted-mutation",
        toolName: "thread_send",
        semanticSlot: "send:persisted-target",
        canonicalRequestHash: "persisted-hash",
        operationId: "persisted-operation",
        providerCreationId: null,
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });

      assert.strictEqual(
        yield* mutations.cancelAllNeverDispatchedByPolicy({
          environmentId,
          controllerThreadId,
          throughControlEpoch: 0,
          cancelledAt: "2026-07-30T00:00:01.000Z",
          sanitizedOutcome: "control_disabled",
        }),
        1,
      );
      assert.strictEqual(
        Option.getOrThrow(yield* mutations.getByActionId("persisted-action")).dispatchState,
        "cancelled_by_policy",
      );
    }),
  );

  it.effect("keeps a claim fenced when control is disabled, released, and later re-enabled", () =>
    Effect.gen(function* () {
      const bindings = yield* VoiceControllerBindingRepository;
      const mutations = yield* VoiceControllerMutationRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("racing-action", "racing-handoff", "racing-turn");
      yield* createBoundAction("inflight-action", "inflight-handoff", "inflight-turn");
      yield* mutations.claimOrReplay({
        voiceActionId: "racing-action",
        mutationKey: "racing-mutation",
        toolName: "thread_send",
        semanticSlot: "send:racing-target",
        canonicalRequestHash: "racing-hash",
        operationId: "racing-operation",
        providerCreationId: null,
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      yield* mutations.claimOrReplay({
        voiceActionId: "inflight-action",
        mutationKey: "inflight-mutation",
        toolName: "thread_send",
        semanticSlot: "send:inflight-target",
        canonicalRequestHash: "inflight-hash",
        operationId: "inflight-operation",
        providerCreationId: null,
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "racing-action",
          claimOwner: "racing-worker",
          claimExpiresAt: "2026-07-30T00:02:00.000Z",
          claimedAt: now,
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "inflight-action",
          claimOwner: "inflight-worker",
          claimExpiresAt: "2026-07-30T00:02:00.000Z",
          claimedAt: now,
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );

      // Disable rotates the durable credential epoch before the policy sweep.
      assert.deepStrictEqual(
        yield* bindings.incrementControlEpoch({
          environmentId,
          expectedControlEpoch: 0,
          updatedAt: "2026-07-30T00:00:01.000Z",
        }),
        { _tag: "incremented", controlEpoch: 1 },
      );
      assert.strictEqual(
        yield* mutations.cancelAllNeverDispatchedByPolicy({
          environmentId,
          controllerThreadId,
          throughControlEpoch: 0,
          cancelledAt: "2026-07-30T00:00:02.000Z",
          sanitizedOutcome: "voice_thread_control_disabled",
        }),
        0,
      );

      // Re-enable does not lower the epoch. A worker that observed disable
      // and releases after re-enable must not recreate replayable work.
      assert.isTrue(
        yield* mutations.releaseClaim({
          voiceActionId: "racing-action",
          claimOwner: "racing-worker",
          mayHavePersistedIntents: false,
          updatedAt: "2026-07-30T00:00:03.000Z",
        }),
      );
      assert.isTrue(
        yield* mutations.releaseClaim({
          voiceActionId: "inflight-action",
          claimOwner: "inflight-worker",
          mayHavePersistedIntents: true,
          updatedAt: "2026-07-30T00:00:03.000Z",
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* mutations.getByActionId("inflight-action")).dispatchState,
        "indeterminate",
      );
      assert.isTrue(
        yield* mutations.recordOutcome({
          voiceActionId: "inflight-action",
          outcome: "confirmed",
          providerAcknowledgedAt: "2026-07-30T00:00:04.000Z",
          outcomeAt: "2026-07-30T00:00:04.000Z",
          sanitizedOutcome: "provider_confirmed",
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* mutations.getByActionId("inflight-action")).dispatchState,
        "confirmed",
      );
      const fenced = Option.getOrThrow(yield* mutations.getByActionId("racing-action"));
      assert.strictEqual(fenced.dispatchState, "cancelled_by_policy");
      assert.strictEqual(fenced.sanitizedOutcome, "voice_thread_control_disabled");
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "racing-action",
          claimOwner: "obsolete-credential",
          claimExpiresAt: "2026-07-30T00:03:00.000Z",
          claimedAt: "2026-07-30T00:01:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "racing-action",
          claimOwner: "new-credential",
          claimExpiresAt: "2026-07-30T00:03:00.000Z",
          claimedAt: "2026-07-30T00:01:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 1,
        }),
      );

      // Fresh work created after re-enable belongs to the new epoch and can
      // cross the dispatch boundary with only the new credential.
      yield* createBoundAction("fresh-action", "fresh-handoff", "fresh-turn");
      yield* mutations.claimOrReplay({
        voiceActionId: "fresh-action",
        mutationKey: "fresh-mutation",
        toolName: "thread_send",
        semanticSlot: "send:fresh-target",
        canonicalRequestHash: "fresh-hash",
        operationId: "fresh-operation",
        providerCreationId: null,
        bindingGeneration: 1,
        controlEpoch: 1,
        createdAt: "2026-07-30T00:01:00.000Z",
      });
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "fresh-action",
          claimOwner: "obsolete-credential",
          claimExpiresAt: "2026-07-30T00:03:00.000Z",
          claimedAt: "2026-07-30T00:01:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "fresh-action",
          claimOwner: "new-credential",
          claimExpiresAt: "2026-07-30T00:03:00.000Z",
          claimedAt: "2026-07-30T00:01:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 1,
        }),
      );
    }),
  );

  it.effect("never cancels a dispatched mutation and records its terminal outcome", () =>
    Effect.gen(function* () {
      const mutations = yield* VoiceControllerMutationRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("action-2", "handoff-2", "turn-2");
      yield* mutations.claimOrReplay({
        voiceActionId: "action-2",
        mutationKey: "mutation-2",
        toolName: "thread_create",
        semanticSlot: "create:project-1",
        canonicalRequestHash: "hash-2",
        operationId: "voice:action-2:create-start",
        providerCreationId: "provider-creation-2",
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });
      yield* mutations.claimDispatch({
        voiceActionId: "action-2",
        claimOwner: "worker-2",
        claimExpiresAt: "2026-07-30T00:01:00.000Z",
        claimedAt: now,
        expectedBindingGeneration: 1,
        expectedControlEpoch: 0,
      });
      assert.isTrue(
        Option.isSome(yield* mutations.getByOperationId("voice:action-2:create-start")),
      );
      assert.isTrue(Option.isNone(yield* mutations.getByOperationId("voice:action-2:create")));
      assert.isTrue(
        yield* mutations.markDispatched({
          voiceActionId: "action-2",
          claimOwner: "worker-2",
          dispatchedAt: "2026-07-30T00:00:30.000Z",
        }),
      );
      assert.strictEqual(
        (yield* mutations.claimOrReplay({
          voiceActionId: "action-2",
          mutationKey: "mutation-2",
          toolName: "thread_create",
          semanticSlot: "create:project-1",
          canonicalRequestHash: "hash-2",
          operationId: "voice:action-2:create-start",
          providerCreationId: "provider-creation-2",
          bindingGeneration: 1,
          controlEpoch: 0,
          createdAt: now,
        }))._tag,
        "replay",
      );
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "action-2",
          claimOwner: "worker-2-replay",
          claimExpiresAt: "2026-07-30T00:02:00.000Z",
          claimedAt: "2026-07-30T00:01:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isFalse(
        yield* mutations.cancelNeverDispatchedByPolicy({
          voiceActionId: "action-2",
          cancelledAt: "2026-07-30T00:00:31.000Z",
          sanitizedOutcome: "control_disabled",
        }),
      );
      assert.isTrue(
        yield* mutations.recordOutcome({
          voiceActionId: "action-2",
          outcome: "confirmed",
          providerAcknowledgedAt: "2026-07-30T00:00:32.000Z",
          outcomeAt: "2026-07-30T00:00:32.000Z",
          sanitizedOutcome: "provider_confirmed",
        }),
      );
      const persisted = Option.getOrNull(yield* mutations.getByActionId("action-2"));
      assert.strictEqual(persisted?.dispatchState, "confirmed");
    }),
  );

  it.effect("reclaims only expired dispatch leases and never reclaims dispatched rows", () =>
    Effect.gen(function* () {
      const mutations = yield* VoiceControllerMutationRepository;
      yield* resetVoiceRows;
      yield* reserveBinding;
      yield* openTransport;
      yield* createBoundAction("action-lease", "handoff-lease", "turn-lease");
      yield* mutations.claimOrReplay({
        voiceActionId: "action-lease",
        mutationKey: "mutation-lease",
        toolName: "thread_create",
        semanticSlot: "create:project-1",
        canonicalRequestHash: "hash-lease",
        operationId: "voice:action-lease:create-start",
        providerCreationId: "provider-creation-lease",
        bindingGeneration: 1,
        controlEpoch: 0,
        createdAt: now,
      });

      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "action-lease",
          claimOwner: "crashed-worker",
          claimExpiresAt: "2026-07-30T00:01:00.000Z",
          claimedAt: now,
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "action-lease",
          claimOwner: "early-retry",
          claimExpiresAt: "2026-07-30T00:01:30.000Z",
          claimedAt: "2026-07-30T00:00:30.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      assert.isTrue(
        yield* mutations.claimDispatch({
          voiceActionId: "action-lease",
          claimOwner: "recovery-worker",
          claimExpiresAt: "2026-07-30T00:03:00.000Z",
          claimedAt: "2026-07-30T00:02:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
      const reclaimed = Option.getOrThrow(yield* mutations.getByActionId("action-lease"));
      assert.strictEqual(reclaimed.dispatchState, "claimed");
      assert.strictEqual(reclaimed.claimOwner, "recovery-worker");

      assert.isTrue(
        yield* mutations.markDispatched({
          voiceActionId: "action-lease",
          claimOwner: "recovery-worker",
          dispatchedAt: "2026-07-30T00:02:30.000Z",
        }),
      );
      assert.isFalse(
        yield* mutations.claimDispatch({
          voiceActionId: "action-lease",
          claimOwner: "forbidden-replay",
          claimExpiresAt: "2026-07-30T00:05:00.000Z",
          claimedAt: "2026-07-30T00:04:00.000Z",
          expectedBindingGeneration: 1,
          expectedControlEpoch: 0,
        }),
      );
    }),
  );
});
