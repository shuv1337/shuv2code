import {
  CommandId,
  MessageId,
  ModelSelection,
  ThreadId,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type TurnId,
} from "@shuv2code/contracts";
import { stableStringify } from "@shuv2code/shared/relaySigning";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { reconcileVoiceMutationOutcomes } from "../../voice/VoiceMutationOutcomeReconciler.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadControlError,
  ThreadControlService,
  type ControllerActionContext,
  type ThreadControlAuthorization,
  type ThreadControlMutationResult,
  type ThreadControlPhase,
  type ThreadControlThreadSummary,
} from "../Services/ThreadControlService.ts";

const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

function shellPhaseOf(thread: OrchestrationThreadShell): ThreadControlPhase {
  const session = thread.session;
  const latestTurn = thread.latestTurn;
  const terminal =
    session === null ||
    session.status === "ready" ||
    session.status === "stopped" ||
    session.status === "error" ||
    session.status === "interrupted" ||
    latestTurn?.state === "completed" ||
    latestTurn?.state === "interrupted" ||
    latestTurn?.state === "error";
  if (!terminal && thread.hasPendingApprovals) return "waiting_for_approval";
  if (!terminal && thread.hasPendingUserInput) return "waiting_for_input";
  if (session?.status === "error" || latestTurn?.state === "error") return "failed";
  if (session?.status === "starting") return "starting";
  if (session?.status === "running" || latestTurn?.state === "running") return "working";
  if (session?.status === "interrupted" || latestTurn?.state === "interrupted") {
    return "interrupted";
  }
  if (latestTurn?.state === "completed") return "completed";
  if (session?.status === "ready" || session?.status === "idle") return "ready";
  return "stopped";
}

function summarizeThread(thread: OrchestrationThreadShell): ThreadControlThreadSummary {
  const phase = shellPhaseOf(thread);
  const terminal =
    phase === "failed" ||
    phase === "interrupted" ||
    phase === "completed" ||
    phase === "ready" ||
    phase === "stopped";
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    phase,
    activeTurnId: terminal ? null : (thread.session?.activeTurnId ?? null),
    hasPendingApproval: !terminal && thread.hasPendingApprovals,
    hasPendingUserInput: !terminal && thread.hasPendingUserInput,
    latestTurnUpdatedAt: thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt ?? null,
  };
}

function operationId(action: ControllerActionContext, operation: string): string {
  return `voice:${action.voiceActionId}:${operation}`;
}

function commandId(action: ControllerActionContext, operation: string): CommandId {
  return CommandId.make(operationId(action, operation));
}

function messageId(action: ControllerActionContext, operation: string): MessageId {
  return MessageId.make(`${operationId(action, operation)}:message`);
}

function requireNonEmpty(value: string, field: string): Effect.Effect<string, ThreadControlError> {
  const trimmed = value.trim();
  return trimmed.length === 0
    ? Effect.fail(
        new ThreadControlError({
          code: "invalid_input",
          message: `${field} must not be empty.`,
        }),
      )
    : Effect.succeed(trimmed);
}

export const validateSendTargetPrecondition = (input: {
  readonly disposition: "start" | "steer";
  readonly expectedTurnId: TurnId | null;
  readonly currentTurnId: TurnId | null;
  readonly targetRuntimeMode: RuntimeMode;
  readonly runtimeCeiling: RuntimeMode;
}): Effect.Effect<void, ThreadControlError> => {
  if (RUNTIME_MODE_RANK[input.targetRuntimeMode] > RUNTIME_MODE_RANK[input.runtimeCeiling]) {
    return Effect.fail(
      new ThreadControlError({
        code: "runtime_ceiling_exceeded",
        message: "The target runtime mode exceeds the controller ceiling.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  if (input.disposition === "start" && input.currentTurnId !== null) {
    return Effect.fail(
      new ThreadControlError({
        code: "expected_idle",
        message: "The target has an active turn.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  if (input.disposition === "steer" && input.currentTurnId !== input.expectedTurnId) {
    return Effect.fail(
      new ThreadControlError({
        code: "stale_target",
        message: "The target active turn changed before steering.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  return Effect.void;
};

export const validateInterruptTargetPrecondition = (input: {
  readonly expectedTurnId: TurnId;
  readonly currentTurnId: TurnId | null;
}): Effect.Effect<void, ThreadControlError> => {
  if (input.currentTurnId === null) {
    return Effect.fail(
      new ThreadControlError({
        code: "already_terminal",
        message: "The target turn is already terminal.",
        currentTurnId: null,
      }),
    );
  }
  if (input.currentTurnId !== input.expectedTurnId) {
    return Effect.fail(
      new ThreadControlError({
        code: "stale_target",
        message: "The target active turn changed before interruption.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  return Effect.void;
};

export const completeClaimedMutationDispatch = <A>(input: {
  readonly dispatchIntents: Effect.Effect<A, ThreadControlError>;
  readonly markDispatched: () => Effect.Effect<boolean, ThreadControlError>;
  readonly releaseClaim: (mayHavePersistedIntents: boolean) => Effect.Effect<void>;
  readonly reconcileOutcome: () => Effect.Effect<void>;
}): Effect.Effect<A, ThreadControlError> =>
  Effect.gen(function* () {
    const outcome = yield* input.dispatchIntents.pipe(
      Effect.tapError(() => input.releaseClaim(true).pipe(Effect.ignore)),
    );
    const marked = yield* input
      .markDispatched()
      .pipe(Effect.tapError(() => input.releaseClaim(true).pipe(Effect.ignore)));
    if (!marked) {
      yield* input.releaseClaim(true).pipe(Effect.ignore);
      return yield* new ThreadControlError({
        code: "dispatch_failed",
        message: "The voice mutation dispatch lease expired.",
      });
    }
    yield* input.reconcileOutcome();
    return outcome;
  });

export const makeThreadControlService = Effect.fn("ThreadControlService.make")(function* () {
  const environment = yield* ServerEnvironment;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const bindings = yield* VoiceControllerBindingRepository;
  const actions = yield* VoiceControllerActionRepository;
  const mutations = yield* VoiceControllerMutationRepository;
  const transports = yield* VoiceTransportSessionRepository;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const persistActiveTarget = Effect.fn("ThreadControlService.persistActiveTarget")(function* (
    authorization: ThreadControlAuthorization,
    activeTargetThreadId: ThreadId,
  ) {
    yield* bindings
      .setActiveTarget({
        environmentId: authorization.environmentId,
        controllerThreadId: authorization.controllerThreadId,
        expectedControlEpoch: authorization.controlEpoch,
        activeTargetThreadId,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.ignore);
  });

  const clearActiveTargetIfMatching = Effect.fn("ThreadControlService.clearActiveTargetIfMatching")(
    function* (authorization: ThreadControlAuthorization, targetThreadId: ThreadId) {
      yield* bindings
        .clearActiveTargetIfMatches({
          environmentId: authorization.environmentId,
          controllerThreadId: authorization.controllerThreadId,
          expectedControlEpoch: authorization.controlEpoch,
          expectedActiveTargetThreadId: targetThreadId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.ignore);
    },
  );

  const authorize = Effect.fn("ThreadControlService.authorize")(function* (
    authorization: ThreadControlAuthorization,
    operation: "read" | "control",
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    if (authorization.environmentId !== environmentId) {
      return yield* new ThreadControlError({
        code: "environment_mismatch",
        message: "The controller grant is for a different environment.",
      });
    }
    const policy = resolveVoiceControlPolicy(
      yield* settings.getSettings.pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "read_disabled",
              message: "The live voice policy could not be read.",
            }),
        ),
      ),
    );
    if (!authorization.canRead || !policy.read) {
      return yield* new ThreadControlError({
        code: "read_disabled",
        message: "Voice thread reads are disabled.",
      });
    }
    if (operation === "control" && (!authorization.canControl || !policy.control)) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: "Voice thread control is disabled.",
      });
    }
    const binding = yield* bindings.getByEnvironmentId(environmentId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live controller binding could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(binding) ||
      binding.value.controllerThreadId !== authorization.controllerThreadId ||
      binding.value.providerInstanceId !== authorization.providerInstanceId ||
      binding.value.authorizedRuntimeCeiling !== authorization.authorizedRuntimeCeiling ||
      binding.value.bindingGeneration !== authorization.bindingGeneration ||
      binding.value.state !== "active"
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The controller credential no longer matches the live binding.",
      });
    }
    if (operation === "control" && binding.value.controlEpoch !== authorization.controlEpoch) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: "The controller credential belongs to an obsolete control epoch.",
      });
    }
  });

  const validateAction = Effect.fn("ThreadControlService.validateAction")(function* (
    authorization: ThreadControlAuthorization,
    action: ControllerActionContext,
  ) {
    if (action.controllerThreadId !== authorization.controllerThreadId) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The action is not bound to this controller.",
      });
    }
    const persisted = yield* actions.getById(action.voiceActionId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live controller action could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(persisted) ||
      persisted.value.state !== "active" ||
      persisted.value.closedAt !== null ||
      persisted.value.controllerThreadId !== authorization.controllerThreadId ||
      persisted.value.transportSessionId !== action.transportSessionId ||
      persisted.value.transportRuntimeInstanceId !== action.runtimeInstanceId ||
      persisted.value.transportGeneration !== action.transportGeneration ||
      persisted.value.controllerRuntimeInstanceId !== action.controllerRuntimeInstanceId ||
      persisted.value.controllerProviderSessionId !== action.controllerCodexProviderThreadId ||
      persisted.value.controllerProviderTurnId !== action.controllerProviderTurnId
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The controller action is closed, stale, or no longer matches its provider turn.",
      });
    }
    const transport = yield* transports.getById(action.transportSessionId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "controller_mismatch",
            message: "The live voice transport could not be read.",
          }),
      ),
    );
    if (
      Option.isNone(transport) ||
      transport.value.state !== "active" ||
      transport.value.controllerThreadId !== authorization.controllerThreadId ||
      transport.value.runtimeInstanceId !== action.runtimeInstanceId ||
      transport.value.generation !== action.transportGeneration
    ) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The voice transport generation has been fenced.",
      });
    }
  });

  const getManagedThread = Effect.fn("ThreadControlService.getManagedThread")(function* (
    authorization: ThreadControlAuthorization,
    threadId: ThreadId,
  ) {
    if (threadId === authorization.controllerThreadId) {
      return yield* new ThreadControlError({
        code: "controller_target_forbidden",
        message: "A voice controller cannot target itself.",
      });
    }
    const snapshot = yield* projection.getThreadDetailSnapshot(threadId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The target projection could not be read.",
          }),
      ),
    );
    if (Option.isNone(snapshot)) {
      yield* clearActiveTargetIfMatching(authorization, threadId);
      return yield* new ThreadControlError({
        code: "thread_not_found",
        message: "The target thread was not found.",
      });
    }
    if (snapshot.value.thread.purpose !== "standard") {
      return yield* new ThreadControlError({
        code: "controller_target_forbidden",
        message: "Voice controllers may target only standard threads.",
      });
    }
    if (snapshot.value.thread.deletedAt !== null || snapshot.value.thread.archivedAt !== null) {
      yield* clearActiveTargetIfMatching(authorization, threadId);
      return yield* new ThreadControlError({
        code: "thread_archived",
        message: "The target thread is deleted or archived.",
      });
    }
    return snapshot.value;
  });

  const getEffectiveRuntimeCeiling = Effect.fn("ThreadControlService.getEffectiveRuntimeCeiling")(
    function* (authorization: ThreadControlAuthorization) {
      const controller = yield* projection
        .getThreadDetailById(authorization.controllerThreadId)
        .pipe(
          Effect.mapError(
            () =>
              new ThreadControlError({
                code: "controller_mismatch",
                message: "The live controller runtime mode could not be read.",
              }),
          ),
        );
      if (Option.isNone(controller) || controller.value.purpose !== "voice-controller") {
        return yield* new ThreadControlError({
          code: "controller_mismatch",
          message: "The designated controller could not be verified.",
        });
      }
      return RUNTIME_MODE_RANK[authorization.authorizedRuntimeCeiling] <=
        RUNTIME_MODE_RANK[controller.value.runtimeMode]
        ? authorization.authorizedRuntimeCeiling
        : controller.value.runtimeMode;
    },
  );

  const dispatch = <A extends Parameters<typeof engine.dispatch>[0]>(
    command: A,
    action: ControllerActionContext,
    authorization: ThreadControlAuthorization,
    provenance: {
      readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
      readonly operation: string;
      readonly canonicalRequestHash: string;
    },
  ): Effect.Effect<{ sequence: number }, ThreadControlError> =>
    engine
      .dispatch(command, {
        actorProvenance: {
          actorKind: "voice-controller",
          voiceActionId: action.voiceActionId,
          controllerThreadId: action.controllerThreadId,
          controllerRuntimeInstanceId: action.controllerRuntimeInstanceId,
          controllerProviderTurnId: action.controllerProviderTurnId,
          providerSessionId: action.controllerCodexProviderThreadId,
          providerInstanceId: authorization.providerInstanceId,
          toolName: provenance.toolName,
          operation: provenance.operation,
          canonicalRequestHash: provenance.canonicalRequestHash,
        },
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The thread command was not accepted.",
            }),
        ),
      );

  const requestHash = (canonicalRequest: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(canonicalRequest)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The voice mutation request could not be authenticated.",
          }),
      ),
    );

  /**
   * Claims the action's single semantic mutation, fences it against the live
   * binding/epoch, persists the dispatch boundary, and replays an exact prior
   * result without issuing another orchestration command.
   */
  const executeMutation = <A extends ThreadControlMutationResult>(input: {
    readonly authorization: ThreadControlAuthorization;
    readonly action: ControllerActionContext;
    readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
    readonly operation: string;
    readonly semanticSlot: string;
    readonly targetThreadId: ThreadId;
    readonly canonicalRequest: string;
    readonly providerCreationId: string | null;
    readonly preDispatch?: Effect.Effect<void, ThreadControlError>;
    readonly effect: (provenance: {
      readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
      readonly operation: string;
      readonly canonicalRequestHash: string;
    }) => Effect.Effect<A, ThreadControlError>;
  }): Effect.Effect<A, ThreadControlError> =>
    Effect.gen(function* () {
      const claimedAt = yield* DateTime.now;
      const claimedAtIso = DateTime.formatIso(claimedAt);
      const mutationKey = `voice:${input.action.voiceActionId}:thread-control`;
      const canonicalRequestHash = yield* requestHash(input.canonicalRequest);
      const claimed = yield* mutations
        .claimOrReplay({
          voiceActionId: input.action.voiceActionId,
          mutationKey,
          toolName: input.toolName,
          semanticSlot: input.semanticSlot,
          canonicalRequestHash,
          operationId: operationId(input.action, input.operation),
          providerCreationId: input.providerCreationId,
          bindingGeneration: input.authorization.bindingGeneration,
          controlEpoch: input.authorization.controlEpoch,
          createdAt: claimedAtIso,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ThreadControlError({
                code: "dispatch_failed",
                message: "The voice mutation could not be durably claimed.",
              }),
          ),
        );
      if (claimed._tag === "conflict" || claimed._tag === "action_unavailable") {
        return yield* new ThreadControlError({
          code: "dispatch_failed",
          message:
            claimed._tag === "conflict"
              ? "This controller action already claimed a different thread mutation."
              : "This controller action is no longer available for mutation.",
        });
      }
      if (
        claimed._tag === "replay" &&
        claimed.mutation.dispatchState !== "never_dispatched" &&
        claimed.mutation.dispatchState !== "claimed"
      ) {
        return yield* new ThreadControlError({
          code: "dispatch_failed",
          message: "The prior voice mutation is already dispatched and is being reconciled.",
        });
      }
      const claimOwner = `${mutationKey}:dispatcher`;
      const dispatchClaimed = yield* mutations
        .claimDispatch({
          voiceActionId: input.action.voiceActionId,
          claimOwner,
          claimExpiresAt: DateTime.formatIso(DateTime.add(claimedAt, { minutes: 1 })),
          claimedAt: claimedAtIso,
          expectedBindingGeneration: input.authorization.bindingGeneration,
          expectedControlEpoch: input.authorization.controlEpoch,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ThreadControlError({
                code: "dispatch_failed",
                message: "The voice mutation dispatch claim failed.",
              }),
          ),
        );
      if (!dispatchClaimed) {
        return yield* new ThreadControlError({
          code: "dispatch_failed",
          message: "The voice mutation dispatch was fenced before it started.",
        });
      }
      // Re-read every mutable privilege boundary immediately before crossing
      // from the durable claim into orchestration.
      yield* Effect.gen(function* () {
        yield* authorize(input.authorization, "control");
        yield* validateAction(input.authorization, input.action);
        if (input.preDispatch !== undefined) {
          yield* input.preDispatch;
        }
      }).pipe(
        Effect.tapError(() =>
          mutations
            .releaseClaim({
              voiceActionId: input.action.voiceActionId,
              claimOwner,
              mayHavePersistedIntents: false,
              updatedAt: DateTime.formatIso(claimedAt),
            })
            .pipe(Effect.ignore),
        ),
      );
      const result = yield* completeClaimedMutationDispatch({
        dispatchIntents: input.effect({
          toolName: input.toolName,
          operation: input.operation,
          canonicalRequestHash,
        }),
        releaseClaim: (mayHavePersistedIntents) =>
          mutations
            .releaseClaim({
              voiceActionId: input.action.voiceActionId,
              claimOwner,
              mayHavePersistedIntents,
              updatedAt: DateTime.formatIso(claimedAt),
            })
            .pipe(Effect.ignore),
        markDispatched: () =>
          Effect.gen(function* () {
            const dispatchedAt = DateTime.formatIso(yield* DateTime.now);
            return yield* mutations
              .markDispatched({
                voiceActionId: input.action.voiceActionId,
                claimOwner,
                dispatchedAt,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new ThreadControlError({
                      code: "dispatch_failed",
                      message: "The voice mutation dispatch boundary could not be persisted.",
                    }),
                ),
              );
          }),
        reconcileOutcome: () =>
          reconcileVoiceMutationOutcomes({ engine, mutations }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("voice mutation post-dispatch outcome reconciliation failed", {
                voiceActionId: input.action.voiceActionId,
                operationId: operationId(input.action, input.operation),
                cause,
              }),
            ),
          ),
      });
      yield* persistActiveTarget(input.authorization, input.targetThreadId);
      return result;
    });

  const list: ThreadControlService["Service"]["list"] = Effect.fn("ThreadControlService.list")(
    function* (input) {
      yield* authorize(input.authorization, "read");
      const snapshot = yield* projection.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The thread inventory could not be read.",
            }),
        ),
      );
      const query = input.projectQuery?.trim().toLocaleLowerCase();
      const projects = snapshot.projects
        .filter(
          (project) => query === undefined || project.title.toLocaleLowerCase().includes(query),
        )
        .map((project) => ({
          projectId: project.id,
          title: project.title,
          ...(project.repositoryIdentity !== null && project.repositoryIdentity !== undefined
            ? { repositoryIdentity: project.repositoryIdentity.canonicalKey }
            : {}),
          defaultModelSelection: project.defaultModelSelection,
        }));
      const projectIds = new Set(projects.map((project) => project.projectId));
      const matchingThreads = snapshot.threads
        .filter(
          (thread) =>
            thread.purpose === "standard" &&
            projectIds.has(thread.projectId) &&
            (input.phase === undefined || shellPhaseOf(thread) === input.phase),
        )
        .map(summarizeThread);
      const cursor = Math.max(0, input.cursor ?? 0);
      const threads = matchingThreads.slice(cursor, cursor + 50);
      return {
        snapshotSequence: snapshot.snapshotSequence,
        projects,
        threads,
        nextCursor:
          cursor + threads.length < matchingThreads.length ? cursor + threads.length : null,
      };
    },
  );

  const get: ThreadControlService["Service"]["get"] = Effect.fn("ThreadControlService.get")(
    function* (input) {
      yield* authorize(input.authorization, "read");
      const snapshot = yield* getManagedThread(input.authorization, input.threadId);
      const thread = snapshot.thread;
      const shell = yield* projection.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The target shell projection could not be read.",
            }),
        ),
      );
      if (Option.isNone(shell)) {
        return yield* new ThreadControlError({
          code: "thread_not_found",
          message: "The target thread was not found.",
        });
      }
      yield* persistActiveTarget(input.authorization, input.threadId);
      const shellSummary = summarizeThread(shell.value);
      const latestAssistant = thread.messages.findLast(
        (candidate) => candidate.role === "assistant" && !candidate.streaming,
      );
      return {
        snapshotSequence: snapshot.snapshotSequence,
        snapshotTimestamp: thread.updatedAt,
        thread: shellSummary,
        latestTurnState: thread.latestTurn?.state ?? null,
        lastErrorCode: thread.session?.lastError === null ? null : "provider_error",
        resultCount: thread.messages.filter((message) => message.role === "assistant").length,
        activityCount: thread.activities.length,
        ...(input.includeUntrustedExcerpt === true && latestAssistant !== undefined
          ? {
              untrustedTargetContent: {
                marker: "untrusted-target-content" as const,
                text: latestAssistant.text.slice(0, 2_048),
              },
            }
          : {}),
      };
    },
  );

  const create: ThreadControlService["Service"]["create"] = Effect.fn(
    "ThreadControlService.create",
  )(function* (input) {
    yield* authorize(input.authorization, "control");
    yield* validateAction(input.authorization, input.action);
    const instruction = yield* requireNonEmpty(input.initialInstruction, "initialInstruction");
    const project = yield* projection.getProjectShellById(input.projectId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The project projection could not be read.",
          }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* new ThreadControlError({
        code: "project_not_found",
        message: "The target project was not found.",
      });
    }
    const controller = yield* projection
      .getThreadDetailById(input.authorization.controllerThreadId)
      .pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The controller projection could not be read.",
            }),
        ),
      );
    if (Option.isNone(controller) || controller.value.purpose !== "voice-controller") {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The designated controller could not be verified.",
      });
    }
    const baseModel = controller.value.modelSelection;
    if (baseModel.instanceId !== input.authorization.providerInstanceId) {
      return yield* new ThreadControlError({
        code: "invalid_model",
        message: "The controller model is not on its bound provider instance.",
      });
    }
    if (input.model !== undefined && input.model !== baseModel.model) {
      return yield* new ThreadControlError({
        code: "invalid_model",
        message: "Voice-created threads must use the live controller model.",
      });
    }
    const modelSelection = ModelSelection.make({
      instanceId: input.authorization.providerInstanceId,
      model: baseModel.model,
      ...(baseModel.options !== undefined ? { options: baseModel.options } : {}),
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(`voice:${input.action.voiceActionId}:thread`);
    const mode =
      RUNTIME_MODE_RANK[input.authorization.authorizedRuntimeCeiling] <=
      RUNTIME_MODE_RANK[controller.value.runtimeMode]
        ? input.authorization.authorizedRuntimeCeiling
        : controller.value.runtimeMode;
    const providerCreationId = `voice-create:${input.action.voiceActionId}`;
    return yield* executeMutation({
      authorization: input.authorization,
      action: input.action,
      toolName: "thread_create",
      // Provider effect acknowledgement belongs to the initial turn start,
      // not the preceding local thread.create event.
      operation: "create-start",
      semanticSlot: `create:${input.projectId}`,
      targetThreadId: threadId,
      providerCreationId,
      canonicalRequest: stableStringify([
        "thread_create",
        input.projectId,
        instruction,
        input.title?.trim() || "",
        modelSelection,
        mode,
      ]),
      effect: (provenance) =>
        Effect.gen(function* () {
          const createResult = yield* dispatch(
            {
              type: "thread.create",
              commandId: commandId(input.action, "create"),
              threadId,
              projectId: input.projectId,
              purpose: "standard",
              title: input.title?.trim() || instruction.slice(0, 80),
              modelSelection,
              runtimeMode: mode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
            input.action,
            input.authorization,
            provenance,
          );
          const startResult = yield* dispatch(
            {
              type: "thread.turn.start",
              commandId: commandId(input.action, "create-start"),
              threadId,
              message: {
                messageId: messageId(input.action, "create-start"),
                role: "user",
                text: instruction,
                attachments: [],
              },
              modelSelection,
              runtimeMode: mode,
              interactionMode: "default",
              expectedTurnId: null,
              providerRecoveryPolicy: "forbid",
              providerThreadSource: `shuv2code/${providerCreationId}`,
              createdAt,
            },
            input.action,
            input.authorization,
            provenance,
          );
          return {
            voiceActionId: input.action.voiceActionId,
            operationId: operationId(input.action, "create-start"),
            targetThreadId: threadId,
            disposition: "create" as const,
            expectedTurnId: null,
            acceptedTurnId: null,
            acceptedProjectionSequence: Math.max(createResult.sequence, startResult.sequence),
            providerConfirmation: "pending" as const,
          };
        }),
    });
  });

  const send: ThreadControlService["Service"]["send"] = Effect.fn("ThreadControlService.send")(
    function* (input) {
      yield* authorize(input.authorization, "control");
      yield* validateAction(input.authorization, input.action);
      const text = yield* requireNonEmpty(input.text, "text");
      const target = yield* getManagedThread(input.authorization, input.threadId);
      const currentCeiling = yield* getEffectiveRuntimeCeiling(input.authorization);
      const currentTurnId = target.thread.session?.activeTurnId ?? null;
      yield* validateSendTargetPrecondition({
        disposition: input.disposition,
        expectedTurnId: input.expectedTurnId,
        currentTurnId,
        targetRuntimeMode: target.thread.runtimeMode,
        runtimeCeiling: currentCeiling,
      });
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return yield* executeMutation({
        authorization: input.authorization,
        action: input.action,
        toolName: "thread_send",
        operation: `send-${input.disposition}`,
        semanticSlot: `send:${input.threadId}`,
        targetThreadId: input.threadId,
        providerCreationId: null,
        canonicalRequest: stableStringify([
          "thread_send",
          input.threadId,
          input.disposition,
          input.expectedTurnId,
          text,
        ]),
        preDispatch: Effect.gen(function* () {
          const liveTarget = yield* getManagedThread(input.authorization, input.threadId);
          const liveCeiling = yield* getEffectiveRuntimeCeiling(input.authorization);
          const liveTurnId = liveTarget.thread.session?.activeTurnId ?? null;
          yield* validateSendTargetPrecondition({
            disposition: input.disposition,
            expectedTurnId: input.expectedTurnId,
            currentTurnId: liveTurnId,
            targetRuntimeMode: liveTarget.thread.runtimeMode,
            runtimeCeiling: liveCeiling,
          });
        }),
        effect: (provenance) =>
          Effect.gen(function* () {
            const result =
              input.disposition === "steer"
                ? yield* dispatch(
                    {
                      type: "thread.turn.steer",
                      commandId: commandId(input.action, "send-steer"),
                      threadId: input.threadId,
                      expectedTurnId: input.expectedTurnId,
                      message: {
                        messageId: messageId(input.action, "send-steer"),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      createdAt,
                    },
                    input.action,
                    input.authorization,
                    provenance,
                  )
                : yield* dispatch(
                    {
                      type: "thread.turn.start",
                      commandId: commandId(input.action, "send-start"),
                      threadId: input.threadId,
                      message: {
                        messageId: messageId(input.action, "send-start"),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      modelSelection: target.thread.modelSelection,
                      runtimeMode: target.thread.runtimeMode,
                      interactionMode: target.thread.interactionMode,
                      expectedTurnId: null,
                      providerRecoveryPolicy: "forbid",
                      createdAt,
                    },
                    input.action,
                    input.authorization,
                    provenance,
                  );
            return {
              voiceActionId: input.action.voiceActionId,
              operationId: operationId(input.action, `send-${input.disposition}`),
              targetThreadId: input.threadId,
              disposition: input.disposition,
              expectedTurnId: input.expectedTurnId,
              acceptedTurnId: input.disposition === "steer" ? input.expectedTurnId : null,
              acceptedProjectionSequence: result.sequence,
              providerConfirmation: "pending" as const,
            };
          }),
      });
    },
  );

  const interrupt: ThreadControlService["Service"]["interrupt"] = Effect.fn(
    "ThreadControlService.interrupt",
  )(function* (input) {
    yield* authorize(input.authorization, "control");
    yield* validateAction(input.authorization, input.action);
    const target = yield* getManagedThread(input.authorization, input.threadId);
    const currentTurnId = target.thread.session?.activeTurnId ?? null;
    yield* validateInterruptTargetPrecondition({
      expectedTurnId: input.expectedTurnId,
      currentTurnId,
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return yield* executeMutation({
      authorization: input.authorization,
      action: input.action,
      toolName: "thread_interrupt",
      operation: "interrupt",
      semanticSlot: `interrupt:${input.threadId}:${input.expectedTurnId}`,
      targetThreadId: input.threadId,
      providerCreationId: null,
      canonicalRequest: stableStringify(["thread_interrupt", input.threadId, input.expectedTurnId]),
      preDispatch: Effect.gen(function* () {
        const liveTarget = yield* getManagedThread(input.authorization, input.threadId);
        const liveTurnId = liveTarget.thread.session?.activeTurnId ?? null;
        yield* validateInterruptTargetPrecondition({
          expectedTurnId: input.expectedTurnId,
          currentTurnId: liveTurnId,
        });
      }),
      effect: (provenance) =>
        Effect.gen(function* () {
          const result = yield* dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: commandId(input.action, "interrupt"),
              threadId: input.threadId,
              turnId: input.expectedTurnId,
              createdAt,
            },
            input.action,
            input.authorization,
            provenance,
          );
          return {
            voiceActionId: input.action.voiceActionId,
            operationId: operationId(input.action, "interrupt"),
            targetThreadId: input.threadId,
            disposition: "interrupt" as const,
            expectedTurnId: input.expectedTurnId,
            acceptedTurnId: input.expectedTurnId,
            acceptedProjectionSequence: result.sequence,
            providerConfirmation: "pending" as const,
          };
        }),
    });
  });

  return ThreadControlService.of({ list, get, create, send, interrupt });
});

export const ThreadControlServiceLive = Layer.effect(
  ThreadControlService,
  makeThreadControlService(),
);
