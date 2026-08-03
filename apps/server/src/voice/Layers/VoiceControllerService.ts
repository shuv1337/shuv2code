import { CommandId, ThreadId, VoiceTranscriptItemId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { parseVoiceHandoffRequest } from "../VoiceHandoffRequest.ts";
import { VoiceControllerService } from "../Services/VoiceControllerService.ts";
import { VoiceControllerActionRunner } from "../Services/VoiceControllerActionRunner.ts";
import { VoiceTargetMonitor } from "../Services/VoiceTargetMonitor.ts";
import { VoiceTransportCoordinator } from "../Services/VoiceTransportCoordinator.ts";
import {
  VoiceRuntimeGateway,
  type VoiceRuntimeGatewayEvent,
} from "../Services/VoiceRuntimeGateway.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  controllerIdentity,
  mapInternalError,
  mapVoiceCatalogError,
  planVoicePolicyTransition,
  voiceError,
} from "./voiceControllerShared.ts";
import { VoiceControllerActionRunnerLive } from "./VoiceControllerActionRunner.ts";
import { VoiceTargetMonitorLive } from "./VoiceTargetMonitor.ts";
import { VoiceTransportCoordinatorLive } from "./VoiceTransportCoordinator.ts";

export {
  appendVoiceSessionEvent,
  claimVoiceTargetPhase,
  confirmedControllerModelSelection,
  controllerActionStartRequest,
  controllerTranscriptWithActiveTarget,
  deriveVoiceActionId,
  planVoicePolicyTransition,
  publicVoiceSessionId,
  runSerializedVoiceActions,
  targetPhaseOf,
  targetThreadIdFromVoiceMutation,
  voiceTargetStatusText,
} from "./voiceControllerShared.ts";

export const makeVoiceControllerService = Effect.fn("VoiceControllerService.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const bindings = yield* VoiceControllerBindingRepository;
  const mutations = yield* VoiceControllerMutationRepository;
  const settings = yield* ServerSettingsService;
  const runtime = yield* VoiceRuntimeGateway;
  const transport = yield* VoiceTransportCoordinator;
  const targets = yield* VoiceTargetMonitor;
  const actionRunner = yield* VoiceControllerActionRunner;
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const currentPolicy = settings.getSettings.pipe(
    Effect.map(resolveVoiceControlPolicy),
    Effect.mapError(mapInternalError("internal_error", "The live voice policy could not be read.")),
  );
  const previousPolicyRef = yield* Ref.make(yield* currentPolicy);

  const getController: VoiceControllerService["Service"]["getController"] = Effect.fn(
    "VoiceControllerService.getController",
  )(function* () {
    const environmentId = yield* environment.getEnvironmentId;
    const binding = yield* bindings
      .getByEnvironmentId(environmentId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be read."),
        ),
      );
    return {
      controller: Option.isSome(binding) ? controllerIdentity(binding.value) : null,
    };
  });

  const ensureController: VoiceControllerService["Service"]["ensureController"] = Effect.fn(
    "VoiceControllerService.ensureController",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.read) {
      return yield* voiceError("permission_denied", "Voice thread reads are disabled.", false);
    }
    const environmentId = yield* environment.getEnvironmentId;
    const project = yield* projection
      .getProjectShellById(input.hostProjectId)
      .pipe(
        Effect.mapError(mapInternalError("internal_error", "The host project could not be read.")),
      );
    if (Option.isNone(project)) {
      return yield* voiceError("controller_not_found", "The host project was not found.", false);
    }
    const preferred =
      input.modelSelection?.instanceId === input.providerInstanceId
        ? input.modelSelection
        : project.value.defaultModelSelection?.instanceId === input.providerInstanceId
          ? project.value.defaultModelSelection
          : undefined;
    const modelSelection = yield* runtime
      .resolveModelSelection(input.providerInstanceId, preferred)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "No compatible model is available on the provider."),
        ),
      );
    const existing = yield* bindings
      .getByEnvironmentId(environmentId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be read."),
        ),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const reservedThreadId = Option.isSome(existing)
      ? existing.value.controllerThreadId
      : ThreadId.make(`voice-controller:${yield* randomUuid}`);
    const reservation = yield* bindings
      .reserve({
        environmentId,
        controllerThreadId: reservedThreadId,
        hostProjectId: input.hostProjectId,
        providerInstanceId: input.providerInstanceId,
        authorizedRuntimeCeiling: input.authorizedRuntimeCeiling,
        bindingGeneration: Option.isSome(existing) ? existing.value.bindingGeneration : 1,
        controlEpoch: Option.isSome(existing) ? existing.value.controlEpoch : 0,
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be reserved."),
        ),
      );
    if (reservation._tag === "conflict") {
      return yield* voiceError(
        "controller_binding_conflict",
        "This environment already has a controller with a different host, provider, or ceiling.",
        false,
      );
    }
    const binding = reservation.binding;
    if (reservation._tag === "created") {
      yield* engine
        .dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make(`voice-controller:create:${binding.controllerThreadId}`),
            threadId: binding.controllerThreadId,
            projectId: binding.hostProjectId,
            purpose: "voice-controller",
            title: "Voice controller",
            modelSelection,
            runtimeMode: binding.authorizedRuntimeCeiling,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: binding.createdAt,
          },
          {
            actorProvenance: {
              actorKind: "voice-controller-supervisor",
              controllerThreadId: binding.controllerThreadId,
              bindingGeneration: binding.bindingGeneration,
            },
          },
        )
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The controller thread could not be created."),
          ),
        );
    }
    const opened = yield* runtime
      .ensureControllerRuntime({
        controllerThreadId: binding.controllerThreadId,
        providerInstanceId: binding.providerInstanceId,
        cwd: project.value.workspaceRoot,
        modelSelection,
        runtimeMode: binding.authorizedRuntimeCeiling,
        creationDisposition: reservation._tag === "created" ? "fresh" : "recover",
        bindingGeneration: binding.bindingGeneration,
        authorizedRuntimeCeiling: binding.authorizedRuntimeCeiling,
        controlEpoch: binding.controlEpoch,
        controlEnabled: policy.control,
      })
      .pipe(
        Effect.tapError(() =>
          bindings
            .compareAndSetState({
              environmentId,
              expectedControllerThreadId: binding.controllerThreadId,
              expectedBindingGeneration: binding.bindingGeneration,
              expectedState: binding.state,
              nextState: "dormant",
              expectedControlEpoch: binding.controlEpoch,
              updatedAt: now,
            })
            .pipe(Effect.ignore),
        ),
        Effect.mapError(
          mapInternalError("internal_error", "The controller runtime could not be opened."),
        ),
      );
    const identityBound = yield* McpSessionRegistry.bindActiveControllerMcpProviderIdentity(
      opened.controllerMcpCredentialId,
      { codexProviderThreadId: opened.codexProviderThreadId },
    );
    if (!identityBound) {
      yield* McpSessionRegistry.revokeActiveMcpThread(binding.controllerThreadId);
      yield* runtime.stopControllerRuntime(binding.controllerThreadId).pipe(Effect.ignore);
      yield* bindings
        .compareAndSetState({
          environmentId,
          expectedControllerThreadId: binding.controllerThreadId,
          expectedBindingGeneration: binding.bindingGeneration,
          expectedState: binding.state,
          nextState: "dormant",
          expectedControlEpoch: binding.controlEpoch,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.ignore);
      return yield* voiceError(
        "internal_error",
        "The controller credential could not be bound to its provider identity.",
        false,
      );
    }
    if (binding.state !== "active") {
      const activated = yield* bindings
        .compareAndSetState({
          environmentId,
          expectedControllerThreadId: binding.controllerThreadId,
          expectedBindingGeneration: binding.bindingGeneration,
          expectedState: binding.state,
          nextState: "active",
          expectedControlEpoch: binding.controlEpoch,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The controller binding could not be activated."),
          ),
        );
      if (!activated) {
        yield* McpSessionRegistry.revokeActiveMcpThread(binding.controllerThreadId);
        yield* runtime.stopControllerRuntime(binding.controllerThreadId).pipe(Effect.ignore);
        return yield* voiceError(
          "controller_binding_conflict",
          "The controller binding changed before runtime activation.",
          true,
        );
      }
    }
    const activeBinding = { ...binding, state: "active" as const };
    yield* transport.putControllerRuntime(binding.controllerThreadId, {
      ...opened,
      controllerThreadId: binding.controllerThreadId,
      modelSelection,
    });
    return { controller: controllerIdentity(activeBinding) };
  });

  // A process restart cannot trust an inherited controller credential when
  // reads or writes are currently disabled. Revoke and rotate before exposing
  // the service, then reopen only a read-capable controller with the exact
  // current policy grant.
  const startupEnvironmentId = yield* environment.getEnvironmentId;
  const startupPolicy = yield* Ref.get(previousPolicyRef);
  if (!startupPolicy.read || !startupPolicy.control) {
    const startupBindingNow = yield* bindings
      .getByEnvironmentId(startupEnvironmentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(startupBindingNow)) {
      const binding = startupBindingNow.value;
      const controller = yield* projection
        .getThreadDetailById(binding.controllerThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      yield* McpSessionRegistry.revokeActiveMcpThread(binding.controllerThreadId);
      yield* runtime.stopControllerRuntime(binding.controllerThreadId).pipe(Effect.ignore);
      if (binding.state === "active") {
        yield* bindings
          .compareAndSetState({
            environmentId: startupEnvironmentId,
            expectedControllerThreadId: binding.controllerThreadId,
            expectedBindingGeneration: binding.bindingGeneration,
            expectedState: "active",
            nextState: "dormant",
            expectedControlEpoch: binding.controlEpoch,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.ignore);
      }
      if (startupPolicy.read && Option.isSome(controller)) {
        yield* ensureController({
          hostProjectId: binding.hostProjectId,
          providerInstanceId: binding.providerInstanceId,
          authorizedRuntimeCeiling: binding.authorizedRuntimeCeiling,
          modelSelection: controller.value.modelSelection,
        }).pipe(Effect.ignore);
      }
    }
  }

  const listVoices: VoiceControllerService["Service"]["listVoices"] = Effect.fn(
    "VoiceControllerService.listVoices",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.realtime || !policy.read) {
      return yield* voiceError("feature_disabled", "Realtime voice is disabled.", false);
    }
    const catalog = yield* runtime
      .listVoices(input.controllerThreadId)
      .pipe(Effect.mapError(mapVoiceCatalogError));
    return {
      voices: catalog.voices.map((voice) => ({
        id: voice.id,
        ...(voice.label !== undefined ? { label: voice.label } : {}),
      })),
      defaultVoiceId: catalog.defaultVoiceId,
    };
  });

  const start: VoiceControllerService["Service"]["start"] = Effect.fn(
    "VoiceControllerService.start",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.realtime || !policy.read) {
      return yield* voiceError("feature_disabled", "Realtime voice is disabled.", false);
    }
    const bindingOption = yield* bindings
      .getByControllerThreadId(input.controllerThreadId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be read."),
        ),
      );
    if (Option.isNone(bindingOption) || bindingOption.value.state !== "active") {
      return yield* voiceError("controller_not_found", "The controller is not active.", false);
    }
    const binding = bindingOption.value;
    const controllerRuntime = yield* transport.getControllerRuntime(binding.controllerThreadId);
    if (controllerRuntime === undefined) {
      return yield* voiceError(
        "controller_runtime_lost",
        "The controller runtime must be reopened.",
        true,
      );
    }
    const project = yield* projection
      .getProjectShellById(binding.hostProjectId)
      .pipe(
        Effect.mapError(mapInternalError("internal_error", "The host project could not be read.")),
      );
    const controller = yield* projection
      .getThreadDetailById(binding.controllerThreadId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller thread could not be read."),
        ),
      );
    if (Option.isNone(project) || Option.isNone(controller)) {
      return yield* voiceError(
        "controller_not_found",
        "The controller host is unavailable.",
        false,
      );
    }
    const environmentId = yield* environment.getEnvironmentId;
    return yield* transport.startTransport({
      start: input,
      binding,
      controllerRuntime,
      environmentId,
      workspaceRoot: project.value.workspaceRoot,
      onActivated: (session) => targets.seedWatchedTargets(session),
    });
  });

  const stop: VoiceControllerService["Service"]["stop"] = (input) => transport.stop(input);

  const resetController: VoiceControllerService["Service"]["resetController"] = Effect.fn(
    "VoiceControllerService.resetController",
  )(function* (input) {
    const environmentId = yield* environment.getEnvironmentId;
    const binding = yield* bindings
      .getByEnvironmentId(environmentId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be read."),
        ),
      );
    if (Option.isNone(binding) || binding.value.controllerThreadId !== input.controllerThreadId) {
      return { reset: false };
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const marked = yield* bindings
      .compareAndSetState({
        environmentId,
        expectedControllerThreadId: binding.value.controllerThreadId,
        expectedBindingGeneration: binding.value.bindingGeneration,
        expectedState: binding.value.state,
        nextState: "resetting",
        expectedControlEpoch: binding.value.controlEpoch,
        updatedAt: now,
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller could not enter resetting state."),
        ),
      );
    if (!marked) {
      return yield* voiceError(
        "controller_binding_conflict",
        "The controller changed while reset was starting.",
        true,
      );
    }
    yield* transport.stopForController(input.controllerThreadId);
    yield* McpSessionRegistry.revokeActiveMcpThread(input.controllerThreadId);
    yield* runtime
      .stopControllerRuntime(input.controllerThreadId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller runtime could not be stopped."),
        ),
      );
    const deleted = yield* bindings
      .deleteResetting({
        environmentId,
        expectedControllerThreadId: binding.value.controllerThreadId,
        expectedBindingGeneration: binding.value.bindingGeneration,
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be cleared."),
        ),
      );
    if (deleted) {
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`voice-controller:archive:${input.controllerThreadId}`),
          threadId: input.controllerThreadId,
        })
        .pipe(Effect.ignore);
    }
    yield* transport.deleteControllerRuntime(input.controllerThreadId);
    return { reset: deleted };
  });

  const subscribe: VoiceControllerService["Service"]["subscribe"] = (input) =>
    transport.subscribe(input);

  const ingestRealtimeEvent: VoiceControllerService["Service"]["ingestRealtimeEvent"] = (input) =>
    actionRunner.ingestRealtimeEvent(input);

  const appendAudio: VoiceControllerService["Service"]["appendAudio"] = (input) =>
    transport.appendAudio(input);

  const handleRuntimeEvent = Effect.fn("VoiceControllerService.handleRuntimeEvent")(function* (
    event: VoiceRuntimeGatewayEvent,
  ) {
    if (event.type === "controller.runtime-lost") {
      const lostRuntime = yield* transport.getControllerRuntime(event.controllerThreadId);
      if (lostRuntime === undefined || lostRuntime.runtimeInstanceId !== event.runtimeInstanceId) {
        return;
      }
      const binding = yield* bindings
        .getByControllerThreadId(event.controllerThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(binding) && binding.value.state === "active") {
        yield* bindings
          .compareAndSetState({
            environmentId: binding.value.environmentId,
            expectedControllerThreadId: binding.value.controllerThreadId,
            expectedBindingGeneration: binding.value.bindingGeneration,
            expectedState: "active",
            nextState: "dormant",
            expectedControlEpoch: binding.value.controlEpoch,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.ignore);
      }
      const affectedSessions = yield* transport.findSessionsByControllerRuntime({
        controllerThreadId: event.controllerThreadId,
        controllerRuntimeInstanceId: event.runtimeInstanceId,
      });
      yield* Effect.forEach(
        affectedSessions,
        (session) =>
          transport
            .emit(session.fence.clientSessionId, {
              type: "session.error",
              code: "controller_runtime_lost",
              retryable: true,
            })
            .pipe(Effect.andThen(transport.stopSession(session))),
        { discard: true },
      );
      yield* McpSessionRegistry.revokeActiveMcpThread(event.controllerThreadId);
      yield* transport.deleteControllerRuntime(event.controllerThreadId);
      if (Option.isSome(binding)) {
        const project = yield* projection
          .getProjectShellById(binding.value.hostProjectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const controller = yield* projection
          .getThreadDetailById(binding.value.controllerThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const policy = yield* currentPolicy.pipe(Effect.option);
        if (Option.isSome(project) && Option.isSome(controller) && Option.isSome(policy)) {
          const restarted = yield* runtime
            .ensureControllerRuntime({
              controllerThreadId: binding.value.controllerThreadId,
              providerInstanceId: binding.value.providerInstanceId,
              cwd: project.value.workspaceRoot,
              modelSelection: lostRuntime.modelSelection,
              runtimeMode: controller.value.runtimeMode,
              creationDisposition: "recover",
              bindingGeneration: binding.value.bindingGeneration,
              authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
              controlEpoch: binding.value.controlEpoch,
              controlEnabled: policy.value.control,
            })
            .pipe(
              Effect.retry({
                times: 2,
                schedule: Schedule.exponential("250 millis"),
              }),
              Effect.option,
            );
          if (Option.isSome(restarted)) {
            const identityBound = yield* McpSessionRegistry.bindActiveControllerMcpProviderIdentity(
              restarted.value.controllerMcpCredentialId,
              { codexProviderThreadId: restarted.value.codexProviderThreadId },
            );
            if (identityBound) {
              yield* bindings
                .compareAndSetState({
                  environmentId: binding.value.environmentId,
                  expectedControllerThreadId: binding.value.controllerThreadId,
                  expectedBindingGeneration: binding.value.bindingGeneration,
                  expectedState: "dormant",
                  nextState: "active",
                  expectedControlEpoch: binding.value.controlEpoch,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                })
                .pipe(Effect.ignore);
              yield* transport.putControllerRuntime(binding.value.controllerThreadId, {
                ...restarted.value,
                controllerThreadId: binding.value.controllerThreadId,
                modelSelection: lostRuntime.modelSelection,
              });
            }
          }
        }
      }
      return;
    }
    const session = yield* transport.findSessionByTransport({
      transportThreadId: event.transportThreadId,
      runtimeInstanceId: event.runtimeInstanceId,
      generation: event.generation,
      realtimeSessionId: event.realtimeSessionId,
    });
    if (session === undefined) return;
    const sessionId = session.fence.clientSessionId;
    switch (event.type) {
      case "transport.transcript.delta":
        yield* transport.emit(sessionId, {
          type: "transcript.delta",
          itemId: VoiceTranscriptItemId.make(event.itemId),
          role: event.role,
          textDelta: event.textDelta.slice(0, 16_384),
        });
        return;
      case "transport.transcript.done":
        yield* transport.emit(sessionId, {
          type: "transcript.done",
          itemId: VoiceTranscriptItemId.make(event.itemId),
          role: event.role,
          text: event.text.slice(0, 120_000),
        });
        return;
      case "transport.item-added": {
        const handoff = yield* parseVoiceHandoffRequest(event.item).pipe(Effect.option);
        if (Option.isNone(handoff)) return;
        yield* actionRunner.enqueueHandoff(session, handoff.value);
        return;
      }
      case "transport.error":
        yield* transport.emit(sessionId, {
          type: "session.error",
          code: "protocol_violation",
          retryable: true,
        });
        return;
      case "transport.closed":
        yield* transport.stopSession(session);
        return;
    }
  });

  yield* runtime.streamEvents.pipe(Stream.runForEach(handleRuntimeEvent), Effect.forkScoped);

  const settingsChanges = yield* settings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach((nextSettings) =>
      Effect.gen(function* () {
        const policy = resolveVoiceControlPolicy(nextSettings);
        const previous = yield* Ref.getAndSet(previousPolicyRef, policy);
        const transition = planVoicePolicyTransition(previous, policy);
        if (transition.incrementControlEpoch) {
          const environmentId = yield* environment.getEnvironmentId;
          const binding = yield* bindings
            .getByEnvironmentId(environmentId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(binding)) {
            yield* bindings
              .incrementControlEpoch({
                environmentId,
                expectedControlEpoch: binding.value.controlEpoch,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              })
              .pipe(Effect.ignore);
          }
          // The epoch rotation and repository predicates jointly close the
          // disable race: this sweep cancels visible never-dispatched rows,
          // stale claims cancel atomically when released, and dispatched work
          // remains on the outcome-reconciliation path without replay.
          if (Option.isSome(binding)) {
            yield* mutations
              .cancelAllNeverDispatchedByPolicy({
                environmentId,
                controllerThreadId: binding.value.controllerThreadId,
                throughControlEpoch: binding.value.controlEpoch,
                cancelledAt: DateTime.formatIso(yield* DateTime.now),
                sanitizedOutcome: "voice_thread_control_disabled",
              })
              .pipe(Effect.ignore);
          }
        }
        if (transition.rotateControllerRuntime) {
          const environmentId = yield* environment.getEnvironmentId;
          let binding = yield* bindings
            .getByEnvironmentId(environmentId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(binding)) {
            const currentBinding = binding.value;
            const controller = yield* projection
              .getThreadDetailById(currentBinding.controllerThreadId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            yield* McpSessionRegistry.revokeActiveMcpThread(currentBinding.controllerThreadId);
            yield* runtime
              .stopControllerRuntime(currentBinding.controllerThreadId)
              .pipe(Effect.ignore);
            yield* transport.deleteControllerRuntime(currentBinding.controllerThreadId);
            if (currentBinding.state === "active") {
              yield* bindings
                .compareAndSetState({
                  environmentId,
                  expectedControllerThreadId: currentBinding.controllerThreadId,
                  expectedBindingGeneration: currentBinding.bindingGeneration,
                  expectedState: "active",
                  nextState: "dormant",
                  expectedControlEpoch: currentBinding.controlEpoch,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                })
                .pipe(Effect.ignore);
            }
            binding = yield* bindings
              .getByEnvironmentId(environmentId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (
              transition.restartControllerRuntime &&
              Option.isSome(binding) &&
              Option.isSome(controller)
            ) {
              yield* ensureController({
                hostProjectId: binding.value.hostProjectId,
                providerInstanceId: binding.value.providerInstanceId,
                authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
                modelSelection: controller.value.modelSelection,
              }).pipe(Effect.ignore);
            }
          }
        }
        if (policy.realtime && policy.read) return;
        yield* transport.stopAll();
      }),
    ),
    Effect.forkScoped,
  );

  return VoiceControllerService.of({
    getController,
    ensureController,
    resetController,
    listVoices,
    start,
    ingestRealtimeEvent,
    appendAudio,
    stop,
    subscribe,
  });
});

const VoiceControllerServiceLayer = Layer.effect(
  VoiceControllerService,
  makeVoiceControllerService(),
);

/** Full voice controller stack: facade + transport + target monitor + action runner. */
export const VoiceControllerServiceLive = VoiceControllerServiceLayer.pipe(
  Layer.provide(VoiceControllerActionRunnerLive),
  Layer.provide(VoiceTargetMonitorLive),
  Layer.provide(VoiceTransportCoordinatorLive),
);
