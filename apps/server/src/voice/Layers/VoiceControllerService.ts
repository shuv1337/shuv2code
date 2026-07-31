import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProjectId,
  type ProviderInstanceId,
  ThreadId,
  VoiceActionId,
  VoiceClientSessionId,
  VoiceControllerError,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  VoiceTranscriptItemId,
  type VoiceControllerIdentity,
  type VoiceTargetPhase,
  type VoiceSessionEvent,
  type VoiceSessionFence,
} from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import type { VoiceTransportSession } from "../../persistence/VoiceControlModels.ts";
import type { VoiceControllerMutation } from "../../persistence/VoiceControlModels.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { parseVoiceHandoffRequest, type VoiceHandoffRequest } from "../VoiceHandoffRequest.ts";
import { reconcileVoiceMutationOutcomes } from "../VoiceMutationOutcomeReconciler.ts";
import { VoiceControllerService } from "../Services/VoiceControllerService.ts";
import {
  VoiceRuntimeGateway,
  type VoiceCodexIdentity,
  type VoiceRuntimeGatewayError,
  type VoiceRuntimeGatewayEvent,
} from "../Services/VoiceRuntimeGateway.ts";

interface ControllerRuntimeState extends VoiceCodexIdentity {
  readonly controllerThreadId: ThreadId;
  readonly controllerMcpCredentialId: string;
  readonly modelSelection: ModelSelection;
}

interface ActiveVoiceSession {
  readonly transportSessionId: string;
  readonly fence: VoiceSessionFence;
  readonly environmentId: EnvironmentId;
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly controller: VoiceControllerIdentity;
  readonly controllerRuntime: ControllerRuntimeState;
  readonly answerSdp: string;
  readonly eventCursor: number;
  readonly history: ReadonlyArray<VoiceSessionEvent>;
}

interface QueuedControllerAction {
  readonly voiceActionId: VoiceActionId;
  readonly sessionId: string;
  readonly transcript: string;
}

interface WatchedVoiceTarget {
  readonly voiceActionId: VoiceActionId;
  readonly transportSessionId: string;
  readonly targetThreadId: ThreadId;
}

export const deriveVoiceActionId = Effect.fn("VoiceControllerService.deriveVoiceActionId")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly transportSessionId: string;
    readonly generation: number;
    readonly handoffId: string;
    readonly itemId: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          [
            input.environmentId,
            input.transportSessionId,
            input.generation,
            input.handoffId,
            input.itemId,
          ].join("\u001f"),
        ),
      )
      .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);
    return VoiceActionId.make(`voice-action:${digest}`);
  },
);

export const controllerActionStartRequest = (input: {
  readonly controllerThreadId: ThreadId;
  readonly controllerRuntimeInstanceId: VoiceRuntimeInstanceId;
  readonly voiceActionId: VoiceActionId;
  readonly transcript: string;
}) => ({
  controllerThreadId: input.controllerThreadId,
  controllerRuntimeInstanceId: input.controllerRuntimeInstanceId,
  clientUserMessageId: input.voiceActionId,
  input: input.transcript,
  recoveryPolicy: "forbid" as const,
});

export const runSerializedVoiceActions = <A, E, R>(
  queue: Queue.Queue<A>,
  process: (action: A) => Effect.Effect<void, E, R>,
) => Stream.fromQueue(queue).pipe(Stream.runForEach(process));

const voiceError = (
  code: ConstructorParameters<typeof VoiceControllerError>[0]["code"],
  message: string,
  retryable: boolean,
) => new VoiceControllerError({ code, message, retryable });

const mapInternalError = (code: "internal_error" | "negotiation_failed", message: string) => () =>
  voiceError(code, message, code === "negotiation_failed");

const mapVoiceCatalogError = (error: VoiceRuntimeGatewayError) => {
  switch (error.code) {
    case "feature_disabled":
    case "method_unavailable":
    case "incompatible_version":
    case "empty_voice_catalog":
      return voiceError(error.code, error.message, false);
    default:
      return voiceError("internal_error", "The realtime voice catalog could not be read.", false);
  }
};

function controllerIdentity(binding: {
  readonly controllerThreadId: ThreadId;
  readonly hostProjectId: VoiceControllerIdentity["hostProjectId"];
  readonly providerInstanceId: VoiceControllerIdentity["providerInstanceId"];
  readonly authorizedRuntimeCeiling: VoiceControllerIdentity["authorizedRuntimeCeiling"];
  readonly bindingGeneration: number;
  readonly controlEpoch: number;
  readonly state: VoiceControllerIdentity["state"];
}): VoiceControllerIdentity {
  return {
    controllerThreadId: binding.controllerThreadId,
    hostProjectId: binding.hostProjectId,
    providerInstanceId: binding.providerInstanceId,
    authorizedRuntimeCeiling: binding.authorizedRuntimeCeiling,
    bindingGeneration: binding.bindingGeneration,
    controlEpoch: binding.controlEpoch,
    state: binding.state,
  };
}

function fenceMatches(session: ActiveVoiceSession, fence: VoiceSessionFence): boolean {
  return (
    session.fence.controllerThreadId === fence.controllerThreadId &&
    session.fence.transportThreadId === fence.transportThreadId &&
    session.fence.clientSessionId === fence.clientSessionId &&
    session.fence.generation === fence.generation &&
    session.fence.runtimeInstanceId === fence.runtimeInstanceId &&
    session.fence.realtimeSessionId === fence.realtimeSessionId
  );
}

export const publicVoiceSessionId = (session: {
  readonly fence: Pick<VoiceSessionFence, "clientSessionId">;
}): VoiceClientSessionId => session.fence.clientSessionId;

export const planVoicePolicyTransition = (
  previous: { readonly read: boolean; readonly control: boolean },
  next: { readonly read: boolean; readonly control: boolean },
) => ({
  incrementControlEpoch: previous.control && !next.control,
  rotateControllerRuntime: previous.read !== next.read || previous.control !== next.control,
  restartControllerRuntime:
    next.read && (previous.read !== next.read || previous.control !== next.control),
});

export const confirmedControllerModelSelection = (runtime: {
  readonly modelSelection: ModelSelection;
}): ModelSelection => runtime.modelSelection;

export const controllerTranscriptWithActiveTarget = (
  transcript: string,
  activeTargetThreadId: ThreadId | null,
): string =>
  activeTargetThreadId === null
    ? transcript
    : [
        "Bounded controller state (resolution hint only; server authorization still applies):",
        `activeTargetThreadId=${JSON.stringify(activeTargetThreadId.slice(0, 256))}`,
        "",
        "User request:",
        transcript,
      ].join("\n");

export const targetThreadIdFromVoiceMutation = (
  mutation: Pick<VoiceControllerMutation, "voiceActionId" | "toolName" | "semanticSlot">,
): ThreadId | undefined => {
  if (mutation.toolName === "thread_create") {
    return ThreadId.make(`voice:${mutation.voiceActionId}:thread`);
  }
  if (mutation.toolName === "thread_send" && mutation.semanticSlot.startsWith("send:")) {
    const threadId = mutation.semanticSlot.slice("send:".length);
    return threadId.length > 0 ? ThreadId.make(threadId) : undefined;
  }
  if (mutation.toolName === "thread_interrupt" && mutation.semanticSlot.startsWith("interrupt:")) {
    const slot = mutation.semanticSlot.slice("interrupt:".length);
    const finalSeparator = slot.lastIndexOf(":");
    const threadId = finalSeparator < 0 ? "" : slot.slice(0, finalSeparator);
    return threadId.length > 0 ? ThreadId.make(threadId) : undefined;
  }
  return undefined;
};

export const claimVoiceTargetPhase = Effect.fn("VoiceControllerService.claimVoiceTargetPhase")(
  function* (
    phasesRef: Ref.Ref<Map<string, VoiceTargetPhase>>,
    watch: Pick<WatchedVoiceTarget, "voiceActionId" | "transportSessionId" | "targetThreadId">,
    phase: VoiceTargetPhase,
  ) {
    const key = `${watch.transportSessionId}\u0000${watch.voiceActionId}\u0000${watch.targetThreadId}`;
    return yield* Ref.modify(phasesRef, (phases) => {
      if (phases.get(key) === phase) return [false, phases] as const;
      const next = new Map(phases);
      next.set(key, phase);
      return [true, next] as const;
    });
  },
);

const domainEventTargetThreadId = (payload: unknown): ThreadId | undefined => {
  if (typeof payload !== "object" || payload === null || !("threadId" in payload)) {
    return undefined;
  }
  const threadId = (payload as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? ThreadId.make(threadId) : undefined;
};

interface VoiceEventSessionState {
  readonly fence: Pick<VoiceSessionFence, "clientSessionId" | "generation" | "runtimeInstanceId">;
  readonly eventCursor: number;
  readonly history: ReadonlyArray<VoiceSessionEvent>;
}

/**
 * Append history and publish while holding one mutex. The publication belongs
 * to the same critical section as cursor allocation, so concurrent emitters
 * cannot publish sequence N+1 before N.
 */
export const appendVoiceSessionEvent = Effect.fn("VoiceControllerService.appendVoiceSessionEvent")(
  function* <Session extends VoiceEventSessionState>(input: {
    readonly sessionsRef: Ref.Ref<Map<string, Session>>;
    readonly events: PubSub.PubSub<VoiceSessionEvent>;
    readonly mutex: Semaphore.Semaphore;
    readonly sessionId: string;
    readonly occurredAt: string;
    readonly payload: VoiceSessionEvent["payload"];
  }) {
    return yield* input.mutex.withPermits(1)(
      Effect.gen(function* () {
        const sessions = yield* Ref.get(input.sessionsRef);
        const current = sessions.get(input.sessionId);
        if (current === undefined) return undefined;
        const sequence = current.eventCursor + 1;
        const event: VoiceSessionEvent = {
          clientSessionId: current.fence.clientSessionId,
          generation: current.fence.generation,
          runtimeInstanceId: current.fence.runtimeInstanceId,
          sequence: VoiceEventSequence.make(sequence),
          occurredAt: input.occurredAt as VoiceSessionEvent["occurredAt"],
          payload: input.payload,
        };
        const next = new Map(sessions);
        next.set(input.sessionId, {
          ...current,
          eventCursor: sequence,
          history: [...current.history, event].slice(-256),
        });
        yield* Ref.set(input.sessionsRef, next);
        yield* PubSub.publish(input.events, event);
        return event;
      }),
    );
  },
);

export function targetPhaseOf(thread: OrchestrationThreadShell): VoiceTargetPhase {
  const hasPendingApprovals: boolean = thread.hasPendingApprovals;
  const hasPendingUserInput: boolean = thread.hasPendingUserInput;
  const latestState: string | null = thread.latestTurn?.state ?? null;
  const sessionStatus: string | null = thread.session?.status ?? null;
  const terminal =
    sessionStatus === null ||
    sessionStatus === "ready" ||
    sessionStatus === "stopped" ||
    sessionStatus === "error" ||
    sessionStatus === "interrupted" ||
    latestState === "completed" ||
    latestState === "interrupted" ||
    latestState === "error";
  if (!terminal && hasPendingApprovals) return "waiting_for_approval";
  if (!terminal && hasPendingUserInput) return "waiting_for_input";
  if (latestState === "error" || sessionStatus === "error") return "failed";
  if (sessionStatus === "starting") return "starting";
  if (latestState === "running" || sessionStatus === "running") {
    return "working";
  }
  if (latestState === "interrupted" || sessionStatus === "interrupted") {
    return "interrupted";
  }
  if (latestState === "completed") return "completed";
  if (sessionStatus === "ready" || sessionStatus === "idle") return "ready";
  return "stopped";
}

export const makeVoiceControllerService = Effect.fn("VoiceControllerService.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const bindings = yield* VoiceControllerBindingRepository;
  const transports = yield* VoiceTransportSessionRepository;
  const actions = yield* VoiceControllerActionRepository;
  const mutations = yield* VoiceControllerMutationRepository;
  const settings = yield* ServerSettingsService;
  const runtime = yield* VoiceRuntimeGateway;
  const events = yield* PubSub.unbounded<VoiceSessionEvent>();
  const eventMutex = yield* Semaphore.make(1);
  const sessionsRef = yield* Ref.make(new Map<string, ActiveVoiceSession>());
  const controllerRuntimesRef = yield* Ref.make(new Map<ThreadId, ControllerRuntimeState>());
  const actionQueue = yield* Queue.unbounded<QueuedControllerAction>();
  const queuedActionIdsRef = yield* Ref.make(new Set<string>());
  const watchedTargetsRef = yield* Ref.make(new Map<string, WatchedVoiceTarget>());
  const watchedTargetPhasesRef = yield* Ref.make(new Map<string, VoiceTargetPhase>());
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const currentPolicy = settings.getSettings.pipe(
    Effect.map(resolveVoiceControlPolicy),
    Effect.mapError(mapInternalError("internal_error", "The live voice policy could not be read.")),
  );
  const previousPolicyRef = yield* Ref.make(yield* currentPolicy);

  const emit = Effect.fn("VoiceControllerService.emit")(function* (
    sessionId: string,
    payload: VoiceSessionEvent["payload"],
  ) {
    yield* appendVoiceSessionEvent({
      sessionsRef,
      events,
      mutex: eventMutex,
      sessionId,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
      payload,
    });
  });

  const watchTarget = (watch: WatchedVoiceTarget) =>
    Ref.update(watchedTargetsRef, (watches) => {
      const next = new Map(watches);
      next.set(`${watch.voiceActionId}\u0000${watch.targetThreadId}`, watch);
      return next;
    });

  const clearActiveTargetIfMatching = Effect.fn(
    "VoiceControllerService.clearActiveTargetIfMatching",
  )(function* (session: ActiveVoiceSession, targetThreadId: ThreadId) {
    yield* bindings
      .clearActiveTargetIfMatches({
        environmentId: session.environmentId,
        controllerThreadId: session.fence.controllerThreadId,
        expectedControlEpoch: session.controller.controlEpoch,
        expectedActiveTargetThreadId: targetThreadId,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.ignore);
  });

  const publishWatchedTarget = Effect.fn("VoiceControllerService.publishWatchedTarget")(function* (
    watch: WatchedVoiceTarget,
  ) {
    const session = Array.from((yield* Ref.get(sessionsRef)).values()).find(
      (candidate) => candidate.transportSessionId === watch.transportSessionId,
    );
    if (session === undefined) return;
    const shell = yield* projection.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined));
    if (shell === undefined) return;
    const target = shell.threads.find((thread) => thread.id === watch.targetThreadId);
    if (target === undefined) {
      yield* clearActiveTargetIfMatching(session, watch.targetThreadId);
      return;
    }
    const project = shell.projects.find((candidate) => candidate.id === target.projectId);
    if (project === undefined || target.purpose !== "standard") {
      yield* clearActiveTargetIfMatching(session, watch.targetThreadId);
      return;
    }
    const phase = targetPhaseOf(target);
    const shouldEmit = yield* claimVoiceTargetPhase(watchedTargetPhasesRef, watch, phase);
    if (!shouldEmit) return;
    yield* emit(session.fence.clientSessionId, {
      type: "target.status",
      voiceActionId: watch.voiceActionId,
      targetThreadId: target.id,
      targetProjectId: target.projectId,
      projectTitle: project.title,
      threadTitle: target.title,
      phase,
      statusText: `Target is ${phase.replaceAll("_", " ")}.`,
      activeTurnId: target.session?.activeTurnId ?? null,
      snapshotSequence: shell.snapshotSequence,
      observedAt: shell.updatedAt,
    });
  });

  const seedWatchedTargets = Effect.fn("VoiceControllerService.seedWatchedTargets")(function* (
    session: ActiveVoiceSession,
  ) {
    const durableActions =
      actions.listRecentByControllerThreadId !== undefined
        ? yield* actions
            .listRecentByControllerThreadId(session.fence.controllerThreadId)
            .pipe(Effect.orElseSucceed(() => []))
        : actions.listByTransportSessionId !== undefined
          ? yield* actions
              .listByTransportSessionId(session.transportSessionId)
              .pipe(Effect.orElseSucceed(() => []))
          : [];
    yield* Effect.forEach(
      durableActions,
      (action) =>
        Effect.gen(function* () {
          const mutation = yield* mutations
            .getByActionId(action.voiceActionId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(mutation)) return;
          if (
            mutation.value.dispatchState === "never_dispatched" ||
            mutation.value.dispatchState === "claimed" ||
            mutation.value.dispatchState === "cancelled_by_policy"
          ) {
            return;
          }
          const targetThreadId = targetThreadIdFromVoiceMutation(mutation.value);
          if (targetThreadId === undefined) return;
          const watch = {
            voiceActionId: VoiceActionId.make(action.voiceActionId),
            transportSessionId: session.transportSessionId,
            targetThreadId,
          };
          yield* watchTarget(watch);
          yield* publishWatchedTarget(watch);
        }),
      { discard: true },
    );
  });

  const archiveTransportThread = (session: VoiceTransportSession) =>
    engine
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(
          `voice-transport:archive:${session.transportSessionId}:${session.generation}`,
        ),
        threadId: session.transportThreadId,
      })
      .pipe(Effect.ignore);

  const cleanupDurableTransportLease = Effect.fn(
    "VoiceControllerService.cleanupDurableTransportLease",
  )(function* (session: VoiceTransportSession) {
    const closedAt = DateTime.formatIso(yield* DateTime.now);
    yield* runtime
      .stopTransport({
        transportThreadId: session.transportThreadId,
        runtimeInstanceId: VoiceRuntimeInstanceId.make(session.runtimeInstanceId),
        generation: VoiceGeneration.make(session.generation),
        ...(session.realtimeSessionId === null
          ? {}
          : { realtimeSessionId: VoiceRealtimeSessionId.make(session.realtimeSessionId) }),
      })
      .pipe(Effect.ignore);
    yield* actions
      .fenceTransportGeneration({
        transportSessionId: session.transportSessionId,
        throughGeneration: session.generation,
        closedAt,
      })
      .pipe(Effect.ignore);
    yield* transports
      .fenceGeneration({
        controllerThreadId: session.controllerThreadId,
        throughGeneration: session.generation,
        fencedAt: closedAt,
      })
      .pipe(Effect.ignore);
    yield* archiveTransportThread(session);
  });

  // In-memory WebRTC state is process-local. Any durable lease left open when
  // this service is constructed belongs to a previous process generation and
  // must be fenced before it can block the next client generation.
  const startupEnvironmentId = yield* environment.getEnvironmentId;
  const startupBinding = yield* bindings
    .getByEnvironmentId(startupEnvironmentId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isSome(startupBinding)) {
    const staleStartupLease = yield* transports
      .getOpenByControllerThreadId(startupBinding.value.controllerThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(staleStartupLease)) {
      yield* cleanupDurableTransportLease(staleStartupLease.value);
    }
  }

  const stopSession = Effect.fn("VoiceControllerService.stopSession")(function* (
    session: ActiveVoiceSession,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* transports
      .compareAndSetState({
        transportSessionId: session.transportSessionId,
        generation: session.fence.generation,
        runtimeInstanceId: session.fence.runtimeInstanceId,
        expectedState: "active",
        nextState: "closing",
        updatedAt: now,
        closedAt: null,
      })
      .pipe(Effect.ignore);
    yield* runtime
      .stopTransport({
        transportThreadId: session.fence.transportThreadId,
        runtimeInstanceId: session.fence.runtimeInstanceId,
        generation: session.fence.generation,
        realtimeSessionId: session.fence.realtimeSessionId,
      })
      .pipe(Effect.ignore);
    yield* actions
      .fenceTransportGeneration({
        transportSessionId: session.transportSessionId,
        throughGeneration: session.fence.generation,
        closedAt: now,
      })
      .pipe(Effect.ignore);
    yield* transports
      .compareAndSetState({
        transportSessionId: session.transportSessionId,
        generation: session.fence.generation,
        runtimeInstanceId: session.fence.runtimeInstanceId,
        expectedState: "closing",
        nextState: "closed",
        updatedAt: now,
        closedAt: now,
      })
      .pipe(Effect.ignore);
    yield* emit(session.fence.clientSessionId, {
      type: "session.state",
      state: "stopped",
    });
    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.delete(session.fence.clientSessionId);
      return next;
    });
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
    yield* Ref.update(controllerRuntimesRef, (runtimes) => {
      const next = new Map(runtimes);
      next.set(binding.controllerThreadId, {
        ...opened,
        controllerThreadId: binding.controllerThreadId,
        modelSelection,
      });
      return next;
    });
    return { controller: controllerIdentity(activeBinding) };
  });

  // A process restart cannot trust an inherited controller credential when
  // reads or writes are currently disabled. Revoke and rotate before exposing
  // the service, then reopen only a read-capable controller with the exact
  // current policy grant.
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
    const environmentId = yield* environment.getEnvironmentId;
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
    const runtimeStates = yield* Ref.get(controllerRuntimesRef);
    const controllerRuntime = runtimeStates.get(binding.controllerThreadId);
    if (controllerRuntime === undefined) {
      return yield* voiceError(
        "controller_runtime_lost",
        "The controller runtime must be reopened.",
        true,
      );
    }
    const existingOpen = yield* transports
      .getOpenByControllerThreadId(input.controllerThreadId)
      .pipe(
        Effect.mapError(mapInternalError("internal_error", "The voice lease could not be read.")),
      );
    if (Option.isSome(existingOpen)) {
      const inMemory = Array.from((yield* Ref.get(sessionsRef)).values()).find(
        (session) => session.transportSessionId === existingOpen.value.transportSessionId,
      );
      if (
        inMemory !== undefined &&
        inMemory.fence.clientSessionId === input.clientSessionId &&
        inMemory.fence.generation === input.generation
      ) {
        yield* seedWatchedTargets(inMemory);
        return {
          controller: inMemory.controller,
          transportThreadId: inMemory.fence.transportThreadId,
          clientSessionId: inMemory.fence.clientSessionId,
          generation: inMemory.fence.generation,
          runtimeInstanceId: inMemory.fence.runtimeInstanceId,
          realtimeSessionId: inMemory.fence.realtimeSessionId,
          answerSdp: inMemory.answerSdp,
          eventCursor: VoiceEventSequence.make(inMemory.eventCursor),
        };
      }
      return yield* voiceError(
        "generation_conflict",
        "This controller already has an active voice transport.",
        false,
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
    // A browser client session may start multiple fenced generations over its
    // lifetime. The durable lease identity therefore includes the generation.
    const transportSessionId = `${input.clientSessionId}:${input.generation}`;
    const transportThreadId = ThreadId.make(
      `voice-transport:${binding.controllerThreadId}:${input.clientSessionId}:${input.generation}`,
    );
    const runtimeInstanceId = VoiceRuntimeInstanceId.make(yield* randomUuid);
    const realtimeSessionId = VoiceRealtimeSessionId.make(yield* randomUuid);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(
          `voice-transport:create:${transportSessionId}:${input.generation}`,
        ),
        threadId: transportThreadId,
        projectId: binding.hostProjectId,
        purpose: "voice-transport",
        title: "Voice transport",
        modelSelection: confirmedControllerModelSelection(controllerRuntime),
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The voice transport could not be provisioned."),
        ),
      );
    const opened = yield* transports
      .openOrReplay({
        transportSessionId,
        environmentId,
        controllerThreadId: binding.controllerThreadId,
        transportThreadId,
        runtimeInstanceId,
        generation: input.generation,
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The voice transport lease could not be reserved."),
        ),
      );
    if (opened._tag === "conflict") {
      return yield* voiceError(
        "generation_conflict",
        "The voice transport generation conflicts with an existing lease.",
        false,
      );
    }
    const negotiated = yield* Effect.gen(function* () {
      const negotiated = yield* runtime
        .startTransport({
          transportThreadId,
          providerInstanceId: binding.providerInstanceId,
          cwd: project.value.workspaceRoot,
          modelSelection: confirmedControllerModelSelection(controllerRuntime),
          runtimeMode: "approval-required",
          runtimeInstanceId,
          generation: input.generation,
          realtimeSessionId,
          offerSdp: input.offerSdp,
          ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
          clientManagedHandoffs: true,
        })
        .pipe(
          Effect.mapError(
            mapInternalError(
              "negotiation_failed",
              "The WebRTC voice session could not be started.",
            ),
          ),
        );
      if (negotiated.runtimeInstanceId !== runtimeInstanceId) {
        return yield* voiceError(
          "protocol_violation",
          "The voice runtime identity changed during negotiation.",
          false,
        );
      }
      const activated = yield* transports
        .activate({
          transportSessionId,
          generation: input.generation,
          runtimeInstanceId,
          realtimeSessionId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The voice transport lease could not be activated."),
          ),
        );
      if (!activated) {
        return yield* voiceError(
          "stale_generation",
          "The voice transport generation was fenced during negotiation.",
          true,
        );
      }
      return negotiated;
    }).pipe(Effect.onError(() => cleanupDurableTransportLease(opened.session)));
    const fence: VoiceSessionFence = {
      controllerThreadId: binding.controllerThreadId,
      transportThreadId,
      clientSessionId: input.clientSessionId,
      generation: input.generation,
      runtimeInstanceId,
      realtimeSessionId,
    };
    const active: ActiveVoiceSession = {
      transportSessionId,
      fence,
      environmentId,
      hostProjectId: binding.hostProjectId,
      providerInstanceId: binding.providerInstanceId,
      controller: controllerIdentity(binding),
      controllerRuntime,
      answerSdp: negotiated.answerSdp,
      eventCursor: 0,
      history: [],
    };
    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.set(input.clientSessionId, active);
      return next;
    });
    const publicSessionId = publicVoiceSessionId(active);
    yield* emit(publicSessionId, { type: "session.state", state: "listening" });
    yield* seedWatchedTargets(active);
    const current = (yield* Ref.get(sessionsRef)).get(publicSessionId) ?? active;
    return {
      controller: current.controller,
      transportThreadId,
      clientSessionId: input.clientSessionId,
      generation: input.generation,
      runtimeInstanceId,
      realtimeSessionId,
      answerSdp: negotiated.answerSdp,
      eventCursor: VoiceEventSequence.make(current.eventCursor),
    };
  });

  const stop: VoiceControllerService["Service"]["stop"] = Effect.fn("VoiceControllerService.stop")(
    function* (input) {
      const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
      if (session === undefined) return { stopped: false };
      if (!fenceMatches(session, input)) {
        return yield* voiceError(
          "stale_generation",
          "The stop request is for an obsolete voice generation.",
          false,
        );
      }
      yield* stopSession(session);
      return { stopped: true };
    },
  );

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
    const sessions = yield* Ref.get(sessionsRef);
    yield* Effect.forEach(
      Array.from(sessions.values()).filter(
        (session) => session.fence.controllerThreadId === input.controllerThreadId,
      ),
      stopSession,
      { discard: true },
    );
    yield* McpSessionRegistry.revokeActiveMcpThread(input.controllerThreadId);
    yield* runtime
      .stopControllerRuntime(input.controllerThreadId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller runtime could not be stopped."),
        ),
      );
    const deleted = yield* bindings
      .deleteResetting(environmentId)
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
    yield* Ref.update(controllerRuntimesRef, (runtimes) => {
      const next = new Map(runtimes);
      next.delete(input.controllerThreadId);
      return next;
    });
    return { reset: deleted };
  });

  const subscribe: VoiceControllerService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const snapshot = yield* eventMutex.withPermits(1)(
          Effect.gen(function* () {
            const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
            const subscription = yield* PubSub.subscribe(events);
            return { session, subscription };
          }),
        );
        const session = snapshot.session;
        if (
          session === undefined ||
          session.fence.generation !== input.generation ||
          session.fence.runtimeInstanceId !== input.runtimeInstanceId
        ) {
          return Stream.fail(
            voiceError("session_not_found", "The voice session is not active.", false),
          );
        }
        const after = input.afterSequence ?? VoiceEventSequence.make(0);
        const replay = session.history.filter((event) => event.sequence > after);
        // Events through the snapshot cursor are already represented by
        // replay. The subscription was installed under the emitter mutex, so
        // every later event is guaranteed to appear in this live stream.
        const live = Stream.fromSubscription(snapshot.subscription).pipe(
          Stream.filter(
            (event) =>
              event.clientSessionId === input.clientSessionId &&
              event.generation === input.generation &&
              event.runtimeInstanceId === input.runtimeInstanceId &&
              event.sequence > session.eventCursor,
          ),
        );
        return Stream.concat(Stream.fromIterable(replay), live);
      }),
    );

  const enqueueHandoff = Effect.fn("VoiceControllerService.enqueueHandoff")(function* (
    session: ActiveVoiceSession,
    handoff: VoiceHandoffRequest,
  ) {
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
    yield* emit(session.fence.clientSessionId, {
      type: "action.status",
      voiceActionId: actionId,
      state: "queued",
      statusText: "Queued for the controller.",
    });
    yield* Queue.offer(actionQueue, {
      voiceActionId: actionId,
      sessionId: session.fence.clientSessionId,
      transcript: handoff.input_transcript,
    });
    return true;
  });

  const ingestRealtimeEvent: VoiceControllerService["Service"]["ingestRealtimeEvent"] = Effect.fn(
    "VoiceControllerService.ingestRealtimeEvent",
  )(function* (input) {
    const session = (yield* Ref.get(sessionsRef)).get(input.clientSessionId);
    if (session === undefined) {
      return yield* voiceError("session_not_found", "The voice session is not active.", false);
    }
    if (!fenceMatches(session, input)) {
      return yield* voiceError(
        "stale_generation",
        "The realtime event is for an obsolete voice generation.",
        false,
      );
    }
    if (input.event.type === "transcript.done") {
      yield* emit(session.fence.clientSessionId, input.event);
      return { accepted: true };
    }
    const accepted = yield* enqueueHandoff(session, {
      type: "handoff_request",
      handoff_id: input.event.handoffId,
      item_id: input.event.itemId,
      input_transcript: input.event.inputTranscript,
    });
    return { accepted };
  });

  const handleRuntimeEvent = Effect.fn("VoiceControllerService.handleRuntimeEvent")(function* (
    event: VoiceRuntimeGatewayEvent,
  ) {
    if (event.type === "controller.runtime-lost") {
      const lostRuntime = (yield* Ref.get(controllerRuntimesRef)).get(event.controllerThreadId);
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
            expectedState: "active",
            nextState: "dormant",
            expectedControlEpoch: binding.value.controlEpoch,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.ignore);
      }
      const sessions = yield* Ref.get(sessionsRef);
      const affectedSessions = Array.from(sessions.values()).filter(
        (session) =>
          session.fence.controllerThreadId === event.controllerThreadId &&
          session.controllerRuntime.runtimeInstanceId === event.runtimeInstanceId,
      );
      yield* Effect.forEach(
        affectedSessions,
        (session) =>
          emit(session.fence.clientSessionId, {
            type: "session.error",
            code: "controller_runtime_lost",
            retryable: true,
          }).pipe(Effect.andThen(stopSession(session))),
        { discard: true },
      );
      yield* McpSessionRegistry.revokeActiveMcpThread(event.controllerThreadId);
      yield* Ref.update(controllerRuntimesRef, (runtimes) => {
        const next = new Map(runtimes);
        next.delete(event.controllerThreadId);
        return next;
      });
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
                  expectedState: "dormant",
                  nextState: "active",
                  expectedControlEpoch: binding.value.controlEpoch,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                })
                .pipe(Effect.ignore);
              yield* Ref.update(controllerRuntimesRef, (runtimes) => {
                const next = new Map(runtimes);
                next.set(binding.value.controllerThreadId, {
                  ...restarted.value,
                  controllerThreadId: binding.value.controllerThreadId,
                  modelSelection: lostRuntime.modelSelection,
                });
                return next;
              });
            }
          }
        }
      }
      return;
    }
    const session = Array.from((yield* Ref.get(sessionsRef)).values()).find(
      (candidate) =>
        candidate.fence.transportThreadId === event.transportThreadId &&
        candidate.fence.runtimeInstanceId === event.runtimeInstanceId &&
        candidate.fence.generation === event.generation &&
        candidate.fence.realtimeSessionId === event.realtimeSessionId,
    );
    if (session === undefined) return;
    const sessionId = session.fence.clientSessionId;
    switch (event.type) {
      case "transport.transcript.delta":
        yield* emit(sessionId, {
          type: "transcript.delta",
          itemId: VoiceTranscriptItemId.make(event.itemId),
          role: event.role,
          textDelta: event.textDelta.slice(0, 16_384),
        });
        return;
      case "transport.transcript.done":
        yield* emit(sessionId, {
          type: "transcript.done",
          itemId: VoiceTranscriptItemId.make(event.itemId),
          role: event.role,
          text: event.text.slice(0, 120_000),
        });
        return;
      case "transport.item-added": {
        const handoff = yield* parseVoiceHandoffRequest(event.item).pipe(Effect.option);
        if (Option.isNone(handoff)) return;
        yield* enqueueHandoff(session, handoff.value);
        return;
      }
      case "transport.error":
        yield* emit(sessionId, {
          type: "session.error",
          code: "protocol_violation",
          retryable: true,
        });
        return;
      case "transport.closed":
        yield* stopSession(session);
        return;
    }
  });

  const processQueuedAction = Effect.fn("VoiceControllerService.processQueuedAction")(function* (
    queued: QueuedControllerAction,
  ) {
    const session = (yield* Ref.get(sessionsRef)).get(queued.sessionId);
    if (session === undefined) return;
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
    yield* emit(queued.sessionId, {
      type: "action.status",
      voiceActionId: queued.voiceActionId,
      state: "controller-starting",
      statusText: "Starting one controller action.",
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
      yield* emit(queued.sessionId, {
        type: "action.status",
        voiceActionId: queued.voiceActionId,
        state: "failed",
        detailCode: "controller_start_failed",
      });
      return;
    }
    if (
      controllerTurn.value.codexProviderThreadId !== session.controllerRuntime.codexProviderThreadId
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
    if (Option.isNone(bound) || bound.value._tag === "conflict" || bound.value._tag === "closed") {
      return;
    }
    yield* emit(queued.sessionId, {
      type: "action.status",
      voiceActionId: queued.voiceActionId,
      state: "controller-working",
      controllerTurnId: controllerTurn.value.turnId,
      statusText: "The controller is working.",
    });
    yield* runtime
      .appendTransportText({
        transportThreadId: session.fence.transportThreadId,
        generation: session.fence.generation,
        text: "The controller accepted this voice action and is working on it.",
      })
      .pipe(Effect.ignore);
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
    yield* runtime
      .appendTransportText({
        transportThreadId: session.fence.transportThreadId,
        generation: session.fence.generation,
        text: speakable,
      })
      .pipe(Effect.ignore);
    // Keep completion delivery text/tray-only until M0 proves appendSpeech
    // audibility and barge-in on the minimum supported Codex build.
    yield* emit(queued.sessionId, {
      type: "action.status",
      voiceActionId: queued.voiceActionId,
      state: terminalState,
      controllerTurnId: controllerTurn.value.turnId,
      statusText: speakable.slice(0, 512),
    });
  });

  yield* runtime.streamEvents.pipe(Stream.runForEach(handleRuntimeEvent), Effect.forkScoped);
  yield* engine.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.type !== "thread.provider-effect-outcome-set") {
          const targetThreadId = domainEventTargetThreadId(event.payload);
          if (targetThreadId === undefined) return;
          const watches = Array.from((yield* Ref.get(watchedTargetsRef)).values()).filter(
            (watch) => watch.targetThreadId === targetThreadId,
          );
          yield* Effect.forEach(watches, publishWatchedTarget, { discard: true });
          return;
        }
        const providerOutcome = event.payload.outcome;
        const mutation = yield* mutations
          .getByOperationId(providerOutcome.operationId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(mutation)) return;

        if (providerOutcome.state !== "pending") {
          yield* mutations
            .recordOutcome({
              voiceActionId: mutation.value.voiceActionId,
              outcome: providerOutcome.state,
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
        const liveSessions = Array.from((yield* Ref.get(sessionsRef)).values());
        const session =
          liveSessions.find(
            (candidate) => candidate.transportSessionId === action.value.transportSessionId,
          ) ??
          liveSessions.find(
            (candidate) =>
              candidate.environmentId === action.value.environmentId &&
              candidate.fence.controllerThreadId === action.value.controllerThreadId,
          );
        if (session === undefined) return;
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
              : providerOutcome.state;
        yield* emit(session.fence.clientSessionId, {
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
        yield* watchTarget(watch);
        if (providerOutcome.state === "stale") {
          const shouldEmit = yield* claimVoiceTargetPhase(watchedTargetPhasesRef, watch, "stale");
          if (shouldEmit) {
            yield* emit(session.fence.clientSessionId, {
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
          yield* publishWatchedTarget(watch);
        }
      }),
    ),
    Effect.forkScoped,
  );
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
            yield* Ref.update(controllerRuntimesRef, (runtimes) => {
              const next = new Map(runtimes);
              next.delete(currentBinding.controllerThreadId);
              return next;
            });
            if (currentBinding.state === "active") {
              yield* bindings
                .compareAndSetState({
                  environmentId,
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
        const sessions = yield* Ref.get(sessionsRef);
        yield* Effect.forEach(sessions.values(), stopSession, { discard: true });
      }),
    ),
    Effect.forkScoped,
  );

  return VoiceControllerService.of({
    ensureController,
    resetController,
    listVoices,
    start,
    ingestRealtimeEvent,
    stop,
    subscribe,
  });
});

export const VoiceControllerServiceLive = Layer.effect(
  VoiceControllerService,
  makeVoiceControllerService(),
);
