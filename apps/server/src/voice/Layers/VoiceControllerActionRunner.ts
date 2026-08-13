import { CommandId, ThreadId, VoiceActionId, VoiceTranscriptItemId } from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { reconcileVoiceMutationOutcomes } from "../VoiceMutationOutcomeReconciler.ts";
import { runVoiceTransportFeedback } from "../VoiceTransportFeedback.ts";
import {
  VoiceControllerActionRunner,
  type QueuedControllerAction,
  type VoiceControllerActionRunnerShape,
} from "../Services/VoiceControllerActionRunner.ts";
import { VoiceCallBridge } from "../Services/VoiceCallBridge.ts";
import { VoiceTargetMonitor } from "../Services/VoiceTargetMonitor.ts";
import { VoiceTransportCoordinator } from "../Services/VoiceTransportCoordinator.ts";
import { VoiceRuntimeGateway } from "../Services/VoiceRuntimeGateway.ts";
import {
  controllerActionStartRequest,
  controllerTranscriptWithActiveTarget,
  deriveVoiceActionId,
  runSerializedVoiceActions,
  voiceError,
} from "./voiceControllerShared.ts";
import { VoiceCallBridgeLive } from "./VoiceCallBridge.ts";

export const makeVoiceControllerActionRunner = Effect.fn("VoiceControllerActionRunner.make")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const projection = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const bindings = yield* VoiceControllerBindingRepository;
    const actions = yield* VoiceControllerActionRepository;
    const mutations = yield* VoiceControllerMutationRepository;
    const settings = yield* ServerSettingsService;
    const runtime = yield* VoiceRuntimeGateway;
    const transport = yield* VoiceTransportCoordinator;
    const targets = yield* VoiceTargetMonitor;
    const callBridge = yield* VoiceCallBridge;
    const actionQueue = yield* Queue.unbounded<QueuedControllerAction>();
    const queuedActionIdsRef = yield* Ref.make(new Set<string>());

    const currentPolicy = settings.getSettings.pipe(
      Effect.map(resolveVoiceControlPolicy),
      Effect.mapError(() =>
        voiceError("internal_error", "The live voice policy could not be read.", false),
      ),
    );

    const enqueueHandoff: VoiceControllerActionRunnerShape["enqueueHandoff"] = Effect.fn(
      "VoiceControllerActionRunner.enqueueHandoff",
    )(function* (session, handoff) {
      if (session.controller === null || session.controllerRuntime === null) return false;
      const actionId = yield* deriveVoiceActionId({
        environmentId: session.environmentId,
        transportSessionId: session.transportSessionId,
        generation: session.fence.generation,
        handoffId: handoff.handoff_id,
        itemId: handoff.item_id,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const created = yield* actions
        .createOrReplay({
          voiceActionId: actionId,
          environmentId: session.environmentId,
          controllerThreadId: session.fence.controllerThreadId,
          transportSessionId: session.transportSessionId,
          transportRuntimeInstanceId: session.fence.runtimeInstanceId,
          transportGeneration: session.fence.generation,
          handoffId: handoff.handoff_id,
          handoffItemId: handoff.item_id,
          clientUserMessageId: actionId,
          controllerRuntimeInstanceId: session.controllerRuntime.runtimeInstanceId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.orElseSucceed(() => ({ _tag: "conflict" as const, action: null })));
      if (created._tag === "conflict" || created.action.state !== "queued") return false;
      const queued = yield* Ref.modify(queuedActionIdsRef, (ids) => {
        if (ids.has(actionId)) return [false, ids] as const;
        const next = new Set(ids);
        next.add(actionId);
        return [true, next] as const;
      });
      if (!queued) return true;
      yield* transport.emit(session.fence.clientSessionId, {
        type: "action.status",
        voiceActionId: actionId,
        state: "queued",
        statusText: "Waiting for the voice controller.",
      });
      yield* Queue.offer(actionQueue, {
        voiceActionId: actionId,
        sessionId: session.fence.clientSessionId,
        transcript: handoff.input_transcript,
      });
      return true;
    });

    const ingestTranscriptDone: VoiceControllerActionRunnerShape["ingestTranscriptDone"] =
      Effect.fn("VoiceControllerActionRunner.ingestTranscriptDone")(function* (session, event) {
        const prior = session.history.find(
          (entry) =>
            entry.payload.type === "transcript.done" &&
            entry.payload.itemId === event.itemId &&
            entry.payload.role === event.role,
        );
        if (prior?.payload.type === "transcript.done" && prior.payload.text !== event.text) {
          return yield* voiceError(
            "protocol_violation",
            "The provider replayed a transcript item with different text.",
            false,
          );
        }
        const transcriptEvent =
          prior ?? (yield* transport.emit(session.fence.clientSessionId, event));
        if (transcriptEvent === undefined) {
          return yield* voiceError("session_not_found", "The voice session is not active.", false);
        }
        if (session.fence.owner?.kind !== "thread-call") {
          return { accepted: true };
        }

        const activeTranscript = [
          ...session.history,
          ...(prior === undefined ? [transcriptEvent] : []),
        ].flatMap((entry) =>
          entry.payload.type === "transcript.done"
            ? [{ role: entry.payload.role, text: entry.payload.text }]
            : [],
        );
        return yield* callBridge.ingestTranscript({
          session,
          itemId: event.itemId,
          role: event.role,
          text: event.text,
          occurredAt: transcriptEvent.occurredAt,
          activeTranscript: activeTranscript.slice(-64),
        });
      });

    const ingestRealtimeEvent: VoiceControllerActionRunnerShape["ingestRealtimeEvent"] = Effect.fn(
      "VoiceControllerActionRunner.ingestRealtimeEvent",
    )(function* (input) {
      const session = yield* transport.getSession(input.clientSessionId);
      if (session === undefined) {
        return yield* voiceError("session_not_found", "The voice session is not active.", false);
      }
      if (!transport.fenceMatches(session, input)) {
        return yield* voiceError(
          "stale_generation",
          "The realtime event is for an obsolete voice generation.",
          false,
        );
      }
      if (input.event.type === "transcript.done") {
        return yield* ingestTranscriptDone(session, input.event);
      }
      if (session.fence.owner?.kind === "thread-call") {
        const delegated = yield* callBridge.delegateUtterance({
          session,
          itemId: VoiceTranscriptItemId.make(input.event.itemId),
          text: input.event.inputTranscript,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
          activeTranscript: input.event.activeTranscript ?? [],
        });
        if (delegated.accepted) {
          yield* transport.emit(session.fence.clientSessionId, {
            type: "session.state",
            state: "thinking",
          });
        }
        return delegated;
      }
      const accepted = yield* enqueueHandoff(session, {
        type: "handoff_request",
        handoff_id: input.event.handoffId,
        item_id: input.event.itemId,
        input_transcript: input.event.inputTranscript,
        ...(input.event.activeTranscript === undefined
          ? {}
          : { active_transcript: input.event.activeTranscript }),
      });
      return { accepted };
    });

    const processQueuedAction = Effect.fn("VoiceControllerActionRunner.processQueuedAction")(
      function* (queued: QueuedControllerAction) {
        const session = yield* transport.getSession(queued.sessionId);
        if (session === undefined) return;
        if (session.controller === null || session.controllerRuntime === null) return;
        const action = yield* actions
          .getById(queued.voiceActionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(action) || action.value.state !== "queued") return;
        const liveBinding = yield* bindings
          .getByControllerThreadId(session.fence.controllerThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const policy = yield* currentPolicy;
        if (!policy.read) {
          yield* actions
            .close({
              voiceActionId: queued.voiceActionId,
              terminalState: "cancelled",
              closedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.ignore);
          return;
        }
        yield* transport.emit(queued.sessionId, {
          type: "action.status",
          voiceActionId: queued.voiceActionId,
          state: "controller-starting",
          statusText: "Opening the voice controller.",
        });
        const controllerTurn = yield* runtime
          .startControllerAction(
            controllerActionStartRequest({
              controllerThreadId: session.fence.controllerThreadId,
              controllerRuntimeInstanceId: session.controllerRuntime.runtimeInstanceId,
              // Deliberate equality boundary: the durable VoiceActionId is also the
              // Codex clientUserMessageId. The model never supplies either identity.
              voiceActionId: queued.voiceActionId,
              transcript: controllerTranscriptWithActiveTarget(
                queued.transcript,
                Option.isSome(liveBinding) ? liveBinding.value.activeTargetThreadId : null,
              ),
            }),
          )
          .pipe(Effect.option);
        if (Option.isNone(controllerTurn)) {
          yield* actions
            .close({
              voiceActionId: queued.voiceActionId,
              terminalState: "failed",
              closedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.ignore);
          yield* transport.emit(queued.sessionId, {
            type: "action.status",
            voiceActionId: queued.voiceActionId,
            state: "failed",
            detailCode: "controller_start_failed",
          });
          return;
        }
        if (
          controllerTurn.value.codexProviderThreadId !==
          session.controllerRuntime.codexProviderThreadId
        ) {
          yield* actions
            .close({
              voiceActionId: queued.voiceActionId,
              terminalState: "failed",
              closedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.ignore);
          return;
        }
        const bound = yield* actions
          .bindControllerTurn({
            voiceActionId: queued.voiceActionId,
            controllerProviderSessionId: controllerTurn.value.codexProviderThreadId,
            controllerProviderTurnId: controllerTurn.value.turnId,
            boundAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.option);
        if (
          Option.isNone(bound) ||
          bound.value._tag === "conflict" ||
          bound.value._tag === "closed"
        ) {
          return;
        }
        yield* transport.emit(queued.sessionId, {
          type: "action.status",
          voiceActionId: queued.voiceActionId,
          state: "controller-working",
          controllerTurnId: controllerTurn.value.turnId,
          statusText: "The controller is reading context or acting. Further requests will queue.",
        });
        yield* runVoiceTransportFeedback(
          runtime.appendTransportText({
            transportThreadId: session.fence.transportThreadId,
            generation: session.fence.generation,
            text: "The controller accepted this voice action and is working on it.",
          }),
        );
        const outcome = yield* runtime
          .awaitControllerAction({
            controllerThreadId: session.fence.controllerThreadId,
            controllerRuntimeInstanceId: session.controllerRuntime.runtimeInstanceId,
            turnId: controllerTurn.value.turnId,
          })
          .pipe(Effect.option);
        yield* Effect.logInfo("voice controller action settled", {
          voiceActionId: queued.voiceActionId,
          controllerTurnId: controllerTurn.value.turnId,
          outcomeStatus: Option.isSome(outcome) ? outcome.value.status : "gateway_error",
        });
        const terminalState =
          Option.isSome(outcome) && outcome.value.status === "completed" ? "completed" : "failed";
        yield* actions
          .close({
            voiceActionId: queued.voiceActionId,
            terminalState,
            closedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.ignore);
        const speakable =
          Option.isSome(outcome) && outcome.value.speakableText !== null
            ? outcome.value.speakableText.slice(0, 2_048)
            : terminalState === "completed"
              ? "The controller action completed."
              : "The controller action failed.";
        // The lifecycle event is authoritative UI state. Emit it before
        // best-effort realtime text/speech so a stale transport cannot leave
        // the surface saying "Listening" while the queue is blocked.
        yield* transport.emit(queued.sessionId, {
          type: "action.status",
          voiceActionId: queued.voiceActionId,
          state: terminalState,
          controllerTurnId: controllerTurn.value.turnId,
          statusText: speakable.slice(0, 512),
        });
        yield* transport.deliverAssistantUpdate({
          session,
          kind:
            terminalState === "completed"
              ? "controller_action_completed"
              : "controller_action_failed",
          text: speakable,
          voiceActionId: queued.voiceActionId,
        });
      },
    );

    const handleProviderEffectOutcome = Effect.fn(
      "VoiceControllerActionRunner.handleProviderEffectOutcome",
    )(function* (event: {
      readonly payload: {
        readonly outcome: {
          readonly operationId: string;
          readonly state: "pending" | "confirmed" | "stale" | "failed" | "cancelled" | string;
          readonly threadId: ThreadId;
          readonly updatedAt: string;
          readonly sanitizedCode: string;
        };
      };
    }) {
      const providerOutcome = event.payload.outcome;
      const mutation = yield* mutations
        .getByOperationId(providerOutcome.operationId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(mutation)) return;

      if (providerOutcome.state !== "pending") {
        const terminalOutcome =
          providerOutcome.state === "confirmed" ||
          providerOutcome.state === "stale" ||
          providerOutcome.state === "failed" ||
          providerOutcome.state === "indeterminate"
            ? providerOutcome.state
            : ("indeterminate" as const);
        yield* mutations
          .recordOutcome({
            voiceActionId: mutation.value.voiceActionId,
            outcome: terminalOutcome,
            providerAcknowledgedAt:
              providerOutcome.state === "confirmed" ? providerOutcome.updatedAt : null,
            outcomeAt: providerOutcome.updatedAt,
            sanitizedOutcome: providerOutcome.sanitizedCode.slice(0, 512),
          })
          .pipe(Effect.ignore);
      }

      const action = yield* actions
        .getById(mutation.value.voiceActionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(action)) return;
      const liveSessions = Array.from((yield* transport.getSessions()).values());
      const session =
        liveSessions.find(
          (candidate) => candidate.transportSessionId === action.value.transportSessionId,
        ) ??
        liveSessions.find(
          (candidate) =>
            candidate.environmentId === action.value.environmentId &&
            candidate.fence.controllerThreadId === action.value.controllerThreadId,
        );
      if (session === undefined || session.controller === null) return;
      const shell = yield* projection
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => undefined));
      if (shell === undefined) return;
      const target = shell.threads.find((thread) => thread.id === providerOutcome.threadId);
      if (target === undefined) return;
      const project = shell.projects.find((candidate) => candidate.id === target.projectId);
      if (project === undefined) return;
      const voiceActionId = VoiceActionId.make(mutation.value.voiceActionId);
      if (providerOutcome.state === "pending" || providerOutcome.state === "confirmed") {
        yield* bindings
          .setActiveTarget({
            environmentId: session.environmentId,
            controllerThreadId: session.fence.controllerThreadId,
            expectedControlEpoch: session.controller.controlEpoch,
            activeTargetThreadId: target.id,
            updatedAt: providerOutcome.updatedAt,
          })
          .pipe(Effect.ignore);
      }
      const actionState =
        providerOutcome.state === "pending"
          ? ("accepted" as const)
          : providerOutcome.state === "confirmed"
            ? ("provider-confirmed" as const)
            : providerOutcome.state === "stale"
              ? ("stale" as const)
              : providerOutcome.state === "failed"
                ? ("failed" as const)
                : ("indeterminate" as const);
      yield* transport.emit(session.fence.clientSessionId, {
        type: "action.status",
        voiceActionId,
        state: actionState,
        ...(action.value.controllerProviderTurnId === null
          ? {}
          : { controllerTurnId: action.value.controllerProviderTurnId }),
        targetThreadId: target.id,
        targetProjectId: target.projectId,
        projectTitle: project.title,
        threadTitle: target.title,
        statusText:
          providerOutcome.state === "confirmed"
            ? "The provider confirmed the target operation."
            : `Target operation: ${providerOutcome.state}.`,
        detailCode: providerOutcome.sanitizedCode.slice(0, 256),
      });
      const watch = {
        voiceActionId,
        targetThreadId: target.id,
        transportSessionId: session.transportSessionId,
      };
      yield* targets.watchTarget(watch);
      if (providerOutcome.state === "stale") {
        const shouldEmit = yield* targets.claimPhase(watch, "stale");
        if (shouldEmit) {
          yield* transport.emit(session.fence.clientSessionId, {
            type: "target.status",
            voiceActionId,
            targetThreadId: target.id,
            targetProjectId: target.projectId,
            projectTitle: project.title,
            threadTitle: target.title,
            phase: "stale",
            statusText: "Target is stale.",
            activeTurnId: target.session?.activeTurnId ?? null,
            snapshotSequence: shell.snapshotSequence,
            observedAt: shell.updatedAt,
          });
        }
      } else {
        yield* targets.publishWatchedTarget(watch);
      }
    });

    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "thread.provider-effect-outcome-set") {
            const targetThreadId = (() => {
              const payload = event.payload;
              if (typeof payload !== "object" || payload === null || !("threadId" in payload)) {
                return undefined;
              }
              const threadId = (payload as { readonly threadId?: unknown }).threadId;
              return typeof threadId === "string" && threadId.length > 0
                ? ThreadId.make(threadId)
                : undefined;
            })();
            if (targetThreadId === undefined) return;
            yield* targets.onDomainThreadEvent({ targetThreadId });
            return;
          }
          yield* handleProviderEffectOutcome(event as never);
        }),
      ),
      Effect.forkScoped,
    );
    yield* runSerializedVoiceActions(actionQueue, (queued) =>
      processQueuedAction(queued).pipe(
        Effect.ensuring(
          Ref.update(queuedActionIdsRef, (ids) => {
            const next = new Set(ids);
            next.delete(queued.voiceActionId);
            return next;
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);

    const startupMutationReconciliation = yield* reconcileVoiceMutationOutcomes({
      engine,
      mutations,
      includeClaimed: true,
      ...(runtime.readThread === undefined ? {} : { readThread: runtime.readThread }),
    });
    yield* Effect.logDebug("Reconciled durable voice mutation outcomes").pipe(
      Effect.annotateLogs(startupMutationReconciliation),
    );
    const recoverableCreations = (yield* mutations.listRecoverable()).filter(
      (mutation) =>
        mutation.toolName === "thread_create" &&
        mutation.providerCreationId !== null &&
        (mutation.dispatchState === "claimed" ||
          mutation.dispatchState === "dispatched" ||
          mutation.dispatchState === "indeterminate"),
    );
    for (const mutation of recoverableCreations) {
      const targetThreadId = ThreadId.make(`voice:${mutation.voiceActionId}:thread`);
      const [detail, shell] = yield* Effect.all([
        projection.getThreadDetailSnapshot(targetThreadId),
        projection.getShellSnapshot(),
      ]);
      if (Option.isNone(detail)) {
        continue;
      }
      const project = shell.projects.find((entry) => entry.id === detail.value.thread.projectId);
      if (project === undefined) {
        continue;
      }
      const thread = detail.value.thread;
      if (runtime.recoverCreatedSession === undefined) {
        continue;
      }
      const recovery = yield* runtime
        .recoverCreatedSession({
          threadId: targetThreadId,
          providerInstanceId: thread.modelSelection.instanceId,
          cwd: thread.worktreePath ?? project.workspaceRoot,
          runtimeMode: thread.runtimeMode,
          modelSelection: thread.modelSelection,
          threadPurpose: "standard",
          threadSource: `shuv2code/${mutation.providerCreationId}`,
        })
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("voice creation source recovery failed", {
              voiceActionId: mutation.voiceActionId,
              operationId: mutation.operationId,
              recoveryCode: "provider_creation_recovery_failed",
            }).pipe(Effect.as({ state: "not_found" as const })),
          ),
        );
      const recoveredAt = DateTime.formatIso(yield* DateTime.now);
      if (recovery.state === "adopted") {
        yield* engine.dispatch({
          type: "thread.provider-effect.outcome.set",
          commandId: CommandId.make(`voice:${mutation.voiceActionId}:creation-recovery-outcome`),
          threadId: targetThreadId,
          outcome: {
            operationId: mutation.operationId,
            operation: "start",
            state: "confirmed",
            threadId: targetThreadId,
            expectedTurnId: null,
            actualTurnId: null,
            sanitizedCode: "provider_creation_recovered",
            updatedAt: recoveredAt,
          },
          createdAt: recoveredAt,
        });
        yield* reconcileVoiceMutationOutcomes({ engine, mutations });
      } else {
        yield* mutations.reconcilePersistedOutcome({
          operationId: mutation.operationId,
          outcome: recovery.state === "ambiguous" ? "stale" : "indeterminate",
          providerAcknowledgedAt: null,
          outcomeAt: recoveredAt,
          sanitizedOutcome:
            recovery.state === "ambiguous"
              ? `provider_creation_ambiguous:${recovery.candidateCount}`
              : "provider_creation_not_found",
        });
      }
    }

    return VoiceControllerActionRunner.of({
      enqueueHandoff,
      ingestRealtimeEvent,
      ingestTranscriptDone,
    });
  },
);

export const VoiceControllerActionRunnerLive = Layer.effect(
  VoiceControllerActionRunner,
  makeVoiceControllerActionRunner(),
).pipe(Layer.provide(VoiceCallBridgeLive));
