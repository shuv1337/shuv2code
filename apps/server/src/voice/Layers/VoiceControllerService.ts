import {
  CommandId,
  ThreadId,
  VoiceCallId,
  VoiceControllerHistoryMessageId,
  VoiceTranscriptItemId,
  type ModelSelection,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type VoiceCallPresence,
  type VoiceControllerHistoryMessage,
  type VoiceSessionStartInput,
} from "@shuv2code/contracts";
import type { Cause } from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceCallEventRepository } from "../../persistence/Services/VoiceCallEvents.ts";
import { VoiceCallRepository } from "../../persistence/Services/VoiceCalls.ts";
import type { VoiceCall, VoiceCallEvent } from "../../persistence/VoiceControlModels.ts";
import { VoiceControllerMutationRepository } from "../../persistence/Services/VoiceControllerMutations.ts";
import { resolveVoiceControlPolicy, ServerSettingsService } from "../../serverSettings.ts";
import { parseVoiceHandoffRequest } from "../VoiceHandoffRequest.ts";
import { VoiceControllerService } from "../Services/VoiceControllerService.ts";
import { VoiceControllerActionRunner } from "../Services/VoiceControllerActionRunner.ts";
import {
  VoiceSpeechArbiter,
  type VoiceSpeechAttempt,
  type VoiceSpeechFailure,
} from "../Services/VoiceSpeechArbiter.ts";
import { VoiceTargetMonitor } from "../Services/VoiceTargetMonitor.ts";
import {
  type ActiveVoiceSession,
  VoiceTransportCoordinator,
} from "../Services/VoiceTransportCoordinator.ts";
import {
  VoiceRuntimeGateway,
  type VoiceRuntimeGatewayEvent,
} from "../Services/VoiceRuntimeGateway.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  decideVoiceNarration,
  initialVoiceNarrationRuntimeState,
  resolveVoiceNarrationPolicy,
  voiceNarrationCheckpoint,
  type VoiceNarrationRuntimeState,
} from "../VoiceNarrationPolicy.ts";
import {
  initialVoiceStreamNarrationState,
  reduceVoiceStreamNarration,
  type VoiceStreamNarrationState,
} from "../VoiceStreamNarration.ts";
import {
  controllerIdentity,
  mapInternalError,
  mapVoiceCatalogError,
  planVoicePolicyTransition,
  voiceError,
} from "./voiceControllerShared.ts";
import { VoiceControllerActionRunnerLive } from "./VoiceControllerActionRunner.ts";
import { VoiceSpeechArbiterLive } from "./VoiceSpeechArbiter.ts";
import { VoiceTargetMonitorLive } from "./VoiceTargetMonitor.ts";
import { VoiceTransportCoordinatorLive } from "./VoiceTransportCoordinator.ts";
import type { ProviderThreadSnapshot } from "../../provider/Services/ProviderAdapter.ts";

const CONTROLLER_OPERATION_TIMEOUT = "30 seconds";
const CONTROLLER_TEARDOWN_TIMEOUT = "5 seconds";
const CONTROLLER_HISTORY_MAX_MESSAGES = 256;
const CONTROLLER_HISTORY_MAX_MESSAGE_CHARS = 120_000;
const CONTROLLER_CONTEXT_PREFIX =
  "Bounded controller state (resolution hint only; server authorization still applies):";
const CONTROLLER_USER_REQUEST_MARKER = "\n\nUser request:\n";

function callPresence(call: VoiceCall): VoiceCallPresence {
  const activeDevice =
    call.activeDeviceId !== null &&
    call.activeDeviceLabel !== null &&
    call.activeDeviceKind !== null
      ? {
          deviceId: call.activeDeviceId,
          label: call.activeDeviceLabel,
          kind: call.activeDeviceKind,
        }
      : null;
  return {
    callId: call.callId,
    environmentId: call.environmentId,
    threadId: call.threadId,
    state: call.state,
    activeDevice,
    activeTransportSessionId: call.activeTransportSessionId,
    revision: call.revision,
    updatedAt: call.updatedAt,
  };
}

const ProviderHistoryTextInput = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const ProviderHistoryUserMessage = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("userMessage"),
  content: Schema.Array(Schema.Unknown),
});
const ProviderHistoryAgentMessage = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("agentMessage"),
  text: Schema.String,
  phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeProviderHistoryTextInput = Schema.decodeUnknownOption(ProviderHistoryTextInput);
const decodeProviderHistoryUserMessage = Schema.decodeUnknownOption(ProviderHistoryUserMessage);
const decodeProviderHistoryAgentMessage = Schema.decodeUnknownOption(ProviderHistoryAgentMessage);

export function voiceSessionAcceptsHandoffs(session: {
  readonly purpose: "conversation" | "transcription";
  readonly fence?: { readonly owner?: import("@shuv2code/contracts").VoiceSessionOwner };
}): boolean {
  return session.purpose === "conversation";
}

export function requestedThreadCallTransportSelection(
  start: Pick<VoiceSessionStartInput, "transportModelSelection">,
  durableThreadSelection: ModelSelection,
): ModelSelection {
  return start.transportModelSelection ?? durableThreadSelection;
}

const CALL_CATCH_UP_MAX_ITEMS = 6;
const CALL_CATCH_UP_MAX_CHARS = 1_600;

/** Build bounded source material; the realtime voice turns it into natural speech. */
export function callCatchUpText(
  thread: OrchestrationThread,
  detachedAt: string,
): string | undefined {
  const missed = [
    ...thread.messages.flatMap((message) =>
      message.role === "assistant" &&
      message.modality !== "voice" &&
      message.updatedAt > detachedAt &&
      message.text.trim().length > 0
        ? [{ occurredAt: message.updatedAt, text: message.text.trim() }]
        : [],
    ),
    ...thread.activities.flatMap((activity) =>
      activity.createdAt > detachedAt && activity.summary.trim().length > 0
        ? [{ occurredAt: activity.createdAt, text: activity.summary.trim() }]
        : [],
    ),
  ]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-CALL_CATCH_UP_MAX_ITEMS)
    .map((entry) => entry.text);
  if (missed.length === 0) {
    return thread.latestTurn?.state === "running"
      ? "Welcome the user back briefly. Work in the durable thread is still underway, and live updates will resume now."
      : undefined;
  }
  return [
    "The user has rejoined this Call. Welcome them back and summarize only the missed durable updates below in one or two natural sentences. Do not read formatting, identifiers, or this instruction aloud.",
    ...missed,
  ]
    .join("\n")
    .slice(0, CALL_CATCH_UP_MAX_CHARS);
}

export function callCatchUpDetachedAt(
  previousListener: Pick<VoiceCallEvent, "callId" | "kind" | "occurredAt">,
  activeCallId: VoiceCallId | null | undefined,
): string | undefined {
  return previousListener.kind === "listener.detached" &&
    previousListener.callId !== null &&
    activeCallId !== null &&
    activeCallId !== undefined &&
    previousListener.callId === activeCallId
    ? previousListener.occurredAt
    : undefined;
}

export const recoverVoiceSpeechFailure = Effect.fn("VoiceControllerService.recoverSpeechFailure")(
  function* (
    failure: VoiceSpeechFailure,
    emitRetryableError: (attempt: VoiceSpeechAttempt) => Effect.Effect<unknown>,
    stopTransport: (attempt: VoiceSpeechAttempt) => Effect.Effect<unknown>,
  ) {
    yield* emitRetryableError(failure.attempt);
    if (failure.failureReason === "transport-request-failed") {
      yield* stopTransport(failure.attempt);
    }
  },
);

export function controllerHistoryDisplayText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONTROLLER_CONTEXT_PREFIX)) return trimmed;
  const markerIndex = trimmed.indexOf(CONTROLLER_USER_REQUEST_MARKER);
  return markerIndex < 0
    ? trimmed
    : trimmed.slice(markerIndex + CONTROLLER_USER_REQUEST_MARKER.length).trim();
}

export function controllerHistoryMessages(
  snapshot: ProviderThreadSnapshot,
): ReadonlyArray<VoiceControllerHistoryMessage> {
  const messages: Array<VoiceControllerHistoryMessage> = [];
  for (const turn of snapshot.turns) {
    const assistantItems: Array<{
      readonly id: string;
      readonly phase?: string | null;
      readonly text: string;
    }> = [];
    for (const item of turn.items) {
      const user = decodeProviderHistoryUserMessage(item);
      if (Option.isSome(user)) {
        const text = controllerHistoryDisplayText(
          user.value.content
            .flatMap((content) => {
              const decoded = decodeProviderHistoryTextInput(content);
              return Option.isSome(decoded) ? [decoded.value.text] : [];
            })
            .join("\n"),
        ).slice(0, CONTROLLER_HISTORY_MAX_MESSAGE_CHARS);
        if (text.length > 0) {
          messages.push({
            id: VoiceControllerHistoryMessageId.make(`${turn.id}:${user.value.id}`),
            turnId: turn.id,
            role: "user",
            text,
          });
        }
        continue;
      }
      const assistant = decodeProviderHistoryAgentMessage(item);
      if (Option.isSome(assistant) && assistant.value.text.trim().length > 0) {
        assistantItems.push(assistant.value);
      }
    }
    const finalItems = assistantItems.filter((item) => item.phase === "final_answer");
    const visibleAssistantItems = finalItems.length > 0 ? finalItems : assistantItems;
    const assistantText = visibleAssistantItems
      .map((item) => item.text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n")
      .slice(0, CONTROLLER_HISTORY_MAX_MESSAGE_CHARS);
    if (assistantText.length > 0) {
      messages.push({
        id: VoiceControllerHistoryMessageId.make(`${turn.id}:assistant`),
        turnId: turn.id,
        role: "assistant",
        text: assistantText,
      });
    }
  }
  return messages.slice(-CONTROLLER_HISTORY_MAX_MESSAGES);
}

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
  const callEvents = yield* VoiceCallEventRepository;
  const calls = yield* VoiceCallRepository;
  const settings = yield* ServerSettingsService;
  const provider = yield* Effect.serviceOption(ProviderService);
  const runtime = yield* VoiceRuntimeGateway;
  const transport = yield* VoiceTransportCoordinator;
  const targets = yield* VoiceTargetMonitor;
  const actionRunner = yield* VoiceControllerActionRunner;
  const speechArbiter = yield* VoiceSpeechArbiter;
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const controllerLifecycle = yield* Semaphore.make(1);
  const narrationLifecycle = yield* Semaphore.make(1);
  const narrationStatesRef = yield* Ref.make(new Map<string, VoiceNarrationRuntimeState>());
  const streamNarrationStatesRef = yield* Ref.make(new Map<string, VoiceStreamNarrationState>());

  const currentPolicy = settings.getSettings.pipe(
    Effect.map(resolveVoiceControlPolicy),
    Effect.mapError(mapInternalError("internal_error", "The live voice policy could not be read.")),
  );
  const previousPolicyRef = yield* Ref.make(yield* currentPolicy);

  const getActiveCall: VoiceControllerService["Service"]["getActiveCall"] = Effect.fn(
    "VoiceControllerService.getActiveCall",
  )(function* () {
    const environmentId = yield* environment.getEnvironmentId;
    const call = yield* calls
      .getActiveByEnvironmentId(environmentId)
      .pipe(
        Effect.mapError(mapInternalError("internal_error", "The active Call could not be read.")),
      );
    return { call: Option.map(call, callPresence).pipe(Option.getOrNull) };
  });

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

  const ensureControllerUnlocked: VoiceControllerService["Service"]["ensureController"] = Effect.fn(
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
        Effect.timeout(CONTROLLER_OPERATION_TIMEOUT),
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
      yield* runtime
        .stopControllerRuntime(binding.controllerThreadId)
        .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
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
        yield* runtime
          .stopControllerRuntime(binding.controllerThreadId)
          .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
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
  const ensureController: VoiceControllerService["Service"]["ensureController"] = (input) =>
    controllerLifecycle.withPermits(1)(ensureControllerUnlocked(input));

  const getControllerHistoryUnlocked: VoiceControllerService["Service"]["getControllerHistory"] =
    Effect.fn("VoiceControllerService.getControllerHistory")(function* (input) {
      const policy = yield* currentPolicy;
      if (!policy.read) {
        return yield* voiceError("permission_denied", "Voice thread reads are disabled.", false);
      }
      if (runtime.readThread === undefined) {
        return yield* voiceError(
          "method_unavailable",
          "The controller provider does not expose conversation history.",
          false,
        );
      }
      const environmentId = yield* environment.getEnvironmentId;
      const binding = yield* bindings
        .getByEnvironmentId(environmentId)
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The controller binding could not be read."),
          ),
        );
      if (Option.isNone(binding) || binding.value.controllerThreadId !== input.controllerThreadId) {
        return yield* voiceError(
          "controller_not_found",
          "The persistent voice controller was not found.",
          false,
        );
      }
      const controller = yield* projection
        .getThreadDetailById(binding.value.controllerThreadId)
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The controller thread could not be read."),
          ),
        );
      if (Option.isNone(controller)) {
        return yield* voiceError(
          "controller_not_found",
          "The persistent voice controller was not found.",
          false,
        );
      }
      yield* ensureControllerUnlocked({
        hostProjectId: binding.value.hostProjectId,
        providerInstanceId: binding.value.providerInstanceId,
        authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
        modelSelection: controller.value.modelSelection,
      });
      const snapshot = yield* runtime
        .readThread(binding.value.controllerThreadId)
        .pipe(
          Effect.timeout(CONTROLLER_OPERATION_TIMEOUT),
          Effect.mapError(
            mapInternalError("internal_error", "The controller conversation could not be read."),
          ),
        );
      return {
        controllerThreadId: binding.value.controllerThreadId,
        messages: controllerHistoryMessages(snapshot),
      };
    });
  const getControllerHistory: VoiceControllerService["Service"]["getControllerHistory"] = (input) =>
    controllerLifecycle.withPermits(1)(getControllerHistoryUnlocked(input));

  const setControllerTarget: VoiceControllerService["Service"]["setControllerTarget"] = Effect.fn(
    "VoiceControllerService.setControllerTarget",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.read) {
      return yield* voiceError("permission_denied", "Voice thread reads are disabled.", false);
    }
    const environmentId = yield* environment.getEnvironmentId;
    const binding = yield* bindings
      .getByEnvironmentId(environmentId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The controller binding could not be read."),
        ),
      );
    if (Option.isNone(binding) || binding.value.controllerThreadId !== input.controllerThreadId) {
      return yield* voiceError(
        "controller_not_found",
        "The persistent voice controller was not found.",
        false,
      );
    }
    const target = yield* projection
      .getThreadDetailById(input.targetThreadId)
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The current thread could not be read."),
        ),
      );
    if (
      Option.isNone(target) ||
      target.value.purpose !== "standard" ||
      target.value.deletedAt !== null ||
      target.value.archivedAt !== null
    ) {
      return yield* voiceError(
        "controller_not_found",
        "The current thread is not available to voice control.",
        false,
      );
    }
    const updated = yield* bindings
      .setActiveTarget({
        environmentId,
        controllerThreadId: binding.value.controllerThreadId,
        expectedControlEpoch: binding.value.controlEpoch,
        activeTargetThreadId: target.value.id,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The current voice target could not be saved."),
        ),
      );
    if (!updated) {
      return yield* voiceError(
        "controller_busy",
        "The voice controller changed while its target was being updated.",
        true,
      );
    }
    return { targetThreadId: target.value.id };
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
      yield* runtime
        .stopControllerRuntime(binding.controllerThreadId)
        .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
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

  const prepareThreadCall: VoiceControllerService["Service"]["prepareThreadCall"] = Effect.fn(
    "VoiceControllerService.prepareThreadCall",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.realtime || !policy.read) {
      return yield* voiceError("feature_disabled", "Realtime voice is disabled.", false);
    }
    const threadSnapshot = yield* projection
      .getThreadDetailSnapshot(input.threadId)
      .pipe(
        Effect.mapError(mapInternalError("internal_error", "The Call thread could not be read.")),
      );
    if (
      Option.isNone(threadSnapshot) ||
      threadSnapshot.value.thread.purpose !== "standard" ||
      threadSnapshot.value.thread.archivedAt !== null ||
      threadSnapshot.value.thread.deletedAt !== null
    ) {
      return yield* voiceError(
        "controller_not_found",
        "The thread is not available for a direct voice call.",
        false,
      );
    }
    const thread = threadSnapshot.value.thread;
    if (runtime.prepareThreadCall === undefined) {
      return { state: "ready", threadId: thread.id, historyMode: "not-applicable" };
    }
    const prepared = yield* runtime
      .prepareThreadCall({
        threadId: thread.id,
        providerInstanceId: thread.modelSelection.instanceId,
        action: input.migrationApproval === "approved" ? "migrate" : "inspect",
      })
      .pipe(
        Effect.mapError(
          mapInternalError("internal_error", "The Call thread could not be prepared."),
        ),
      );
    return { ...prepared, threadId: thread.id };
  });

  const startUnlocked: VoiceControllerService["Service"]["start"] = Effect.fn(
    "VoiceControllerService.start",
  )(function* (input) {
    const policy = yield* currentPolicy;
    if (!policy.realtime || !policy.read) {
      return yield* voiceError("feature_disabled", "Realtime voice is disabled.", false);
    }
    const environmentId = yield* environment.getEnvironmentId;
    if (input.environmentId !== undefined && input.environmentId !== environmentId) {
      return yield* voiceError(
        "protocol_violation",
        "The voice session belongs to another environment.",
        false,
      );
    }
    if (input.owner?.kind === "thread-call") {
      if (input.owner.threadId !== input.controllerThreadId) {
        return yield* voiceError(
          "protocol_violation",
          "The Call owner does not match its compatibility anchor.",
          false,
        );
      }
      const threadSnapshot = yield* projection
        .getThreadDetailSnapshot(input.owner.threadId)
        .pipe(
          Effect.mapError(mapInternalError("internal_error", "The Call thread could not be read.")),
        );
      if (
        Option.isNone(threadSnapshot) ||
        threadSnapshot.value.thread.purpose !== "standard" ||
        threadSnapshot.value.thread.archivedAt !== null ||
        threadSnapshot.value.thread.deletedAt !== null
      ) {
        return yield* voiceError(
          "controller_not_found",
          "The thread is not available for a direct voice call.",
          false,
        );
      }
      const thread = threadSnapshot.value.thread;
      const project = yield* projection
        .getProjectShellById(thread.projectId)
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The Call project could not be read."),
          ),
        );
      if (Option.isNone(project)) {
        return yield* voiceError("controller_not_found", "The Call project is unavailable.", false);
      }
      const requestedTransportSelection = requestedThreadCallTransportSelection(
        input,
        thread.modelSelection,
      );
      const transportModelSelection = yield* runtime
        .resolveModelSelection(requestedTransportSelection.instanceId, requestedTransportSelection)
        .pipe(
          Effect.mapError(
            mapInternalError(
              "negotiation_failed",
              "No compatible realtime voice model is available.",
            ),
          ),
        );
      const previousListener = yield* callEvents
        .getLatestListenerEvent({ environmentId, threadId: thread.id })
        .pipe(
          Effect.mapError(
            mapInternalError("internal_error", "The previous Call position could not be read."),
          ),
        );
      const started = yield* transport.startThreadCallTransport({
        start: { ...input, owner: input.owner },
        environmentId,
        thread,
        transportModelSelection,
        workspaceRoot: project.value.workspaceRoot,
        threadSnapshotSequence: threadSnapshot.value.snapshotSequence,
      });
      const catchUpDetachedAt = Option.isSome(previousListener)
        ? callCatchUpDetachedAt(previousListener.value, started.call?.callId)
        : undefined;
      const catchUp =
        catchUpDetachedAt === undefined ? undefined : callCatchUpText(thread, catchUpDetachedAt);
      if (catchUp !== undefined) {
        const session = yield* transport.getSession(input.clientSessionId);
        if (session !== undefined) {
          yield* speechArbiter.enqueue({
            attemptId: yield* randomUuid,
            source: "catch-up",
            session,
            threadId: thread.id,
            turnId: thread.latestTurn?.turnId ?? null,
            requestedText: catchUp,
            requestedAt: DateTime.formatIso(yield* DateTime.now),
          });
        }
      }
      return started;
    }
    if (
      (input.owner?.kind === "controller" &&
        input.owner.controllerThreadId !== input.controllerThreadId) ||
      (input.owner?.kind === "transcription-test" &&
        input.owner.providerAnchorThreadId !== input.controllerThreadId)
    ) {
      return yield* voiceError(
        "protocol_violation",
        "The voice owner does not match its compatibility anchor.",
        false,
      );
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
    const started = yield* transport
      .startTransport({
        start: input,
        binding,
        controllerRuntime,
        environmentId,
        workspaceRoot: project.value.workspaceRoot,
        onActivated: (session) => targets.seedWatchedTargets(session),
      })
      .pipe(Effect.timeoutOption(CONTROLLER_OPERATION_TIMEOUT));
    if (Option.isNone(started)) {
      return yield* voiceError(
        "internal_error",
        "The voice transport did not start before the lifecycle deadline.",
        true,
      );
    }
    return started.value;
  });
  const start: VoiceControllerService["Service"]["start"] = (input) =>
    controllerLifecycle.withPermits(1)(startUnlocked(input));

  const stop: VoiceControllerService["Service"]["stop"] = Effect.fn("VoiceControllerService.stop")(
    function* (input) {
      const session = yield* transport.getSession(input.clientSessionId);
      const result = yield* transport.stop(input);
      if (session !== undefined) yield* speechArbiter.close(session);
      return result;
    },
  );

  const resetControllerUnlocked: VoiceControllerService["Service"]["resetController"] = Effect.fn(
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
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
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
        yield* restore(transport.stopForController(input.controllerThreadId)).pipe(Effect.exit);
        yield* McpSessionRegistry.revokeActiveMcpThread(input.controllerThreadId);
        yield* restore(runtime.stopControllerRuntime(input.controllerThreadId)).pipe(
          Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT),
          Effect.exit,
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
      }),
    );
  });
  const resetController: VoiceControllerService["Service"]["resetController"] = (input) =>
    controllerLifecycle.withPermits(1)(resetControllerUnlocked(input));

  const subscribe: VoiceControllerService["Service"]["subscribe"] = (input) =>
    transport.subscribe(input);

  const ingestRealtimeEvent: VoiceControllerService["Service"]["ingestRealtimeEvent"] = (input) =>
    actionRunner.ingestRealtimeEvent(input);

  const appendAudio: VoiceControllerService["Service"]["appendAudio"] = (input) =>
    transport.appendAudio(input);

  const queueThreadCallSpeech = Effect.fn("VoiceControllerService.queueThreadCallSpeech")(
    function* (input: {
      readonly environmentId: import("@shuv2code/contracts").EnvironmentId;
      readonly threadId: ThreadId;
      readonly text: string;
      readonly source: "authored" | "commentary" | "ambient";
      readonly turnId?: ProviderRuntimeEvent["turnId"] | null;
      readonly attemptId?: string;
      readonly groupId?: string;
      readonly terminal?: boolean;
    }) {
      const session = Array.from((yield* transport.getSessions()).values()).find(
        (candidate) =>
          candidate.environmentId === input.environmentId &&
          candidate.fence.owner?.kind === "thread-call" &&
          candidate.fence.owner.threadId === input.threadId,
      );
      if (session === undefined) return false;
      const text = input.text.trim().slice(0, 2_048);
      if (text.length === 0) return false;
      const thread =
        input.source === "authored"
          ? yield* projection
              .getThreadDetailById(input.threadId)
              .pipe(
                Effect.mapError(
                  mapInternalError("internal_error", "The called thread could not be read."),
                ),
              )
          : Option.none();
      if (input.source === "authored" && Option.isNone(thread)) return false;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const speechId = input.attemptId ?? (yield* randomUuid);
      const accepted = yield* speechArbiter.enqueue({
        attemptId: speechId,
        source: input.source,
        session,
        threadId: input.threadId,
        turnId:
          input.turnId ??
          (Option.isSome(thread) ? (thread.value.latestTurn?.turnId ?? null) : null),
        requestedText: text,
        requestedAt: createdAt,
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
      });
      if (accepted && input.source !== "ambient") {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Ref.update(narrationStatesRef, (states) => {
          const current = states.get(session.transportSessionId);
          const next = new Map(states);
          next.set(session.transportSessionId, {
            ...(current ?? initialVoiceNarrationRuntimeState(nowMs)),
            pending: null,
            lastSpeechAtMs: nowMs,
          });
          return next;
        });
      }
      return accepted;
    },
  );

  const speakInThreadCall: VoiceControllerService["Service"]["speakInThreadCall"] = (input) =>
    queueThreadCallSpeech({ ...input, source: "authored" });

  const activeThreadCallSessions = Effect.fn("VoiceControllerService.activeThreadCallSessions")(
    function* (threadId: ThreadId) {
      return Array.from((yield* transport.getSessions()).values()).filter(
        (session) =>
          session.purpose === "conversation" &&
          session.fence.owner?.kind === "thread-call" &&
          session.fence.owner.threadId === threadId,
      );
    },
  );

  const markThreadCallSpeech = Effect.fn("VoiceControllerService.markThreadCallSpeech")(function* (
    threadId: ThreadId,
  ) {
    const sessions = yield* activeThreadCallSessions(threadId);
    if (sessions.length === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(narrationStatesRef, (states) => {
      const next = new Map(states);
      for (const session of sessions) {
        const current =
          next.get(session.transportSessionId) ?? initialVoiceNarrationRuntimeState(nowMs);
        next.set(session.transportSessionId, { ...current, lastSpeechAtMs: nowMs });
      }
      return next;
    });
  });

  const attemptThreadCallNarration = Effect.fn("VoiceControllerService.attemptThreadCallNarration")(
    function* (session: ActiveVoiceSession) {
      yield* narrationLifecycle.withPermits(1)(
        Effect.gen(function* () {
          const owner = session.fence.owner;
          if (owner?.kind !== "thread-call") return;
          const current = (yield* Ref.get(narrationStatesRef)).get(session.transportSessionId);
          if (current === undefined) return;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const narrationSettings = yield* settings.getSettings;
          const decision = decideVoiceNarration({
            policy: resolveVoiceNarrationPolicy(narrationSettings.voiceNarrationLevel),
            state: current,
            nowMs,
          });
          if (!decision.speak || current.pending === null) return;
          const narratedKey = current.pending.key;
          const spoken = yield* queueThreadCallSpeech({
            environmentId: session.environmentId,
            threadId: owner.threadId,
            text: decision.text,
            source: "ambient",
          });
          if (!spoken) return;
          yield* Ref.update(narrationStatesRef, (states) => {
            const next = new Map(states);
            const latest = next.get(session.transportSessionId);
            if (latest !== undefined) {
              next.set(session.transportSessionId, {
                ...latest,
                lastNarratedKey: narratedKey,
                lastNarratedText: decision.text,
                lastSpeechAtMs: nowMs,
              });
            }
            return next;
          });
        }),
      );
    },
  );

  const observeNarrationRuntimeEvent = Effect.fn(
    "VoiceControllerService.observeNarrationRuntimeEvent",
  )(function* (event: ProviderRuntimeEvent) {
    const sessions = yield* activeThreadCallSessions(event.threadId);
    if (sessions.length === 0) return;
    const streamMode =
      (yield* settings.getSettings).voiceNarrationLevel === "quiet"
        ? ("final-only" as const)
        : ("streaming" as const);
    yield* Effect.forEach(
      sessions,
      (session) =>
        Effect.gen(function* () {
          const update = yield* Ref.modify(streamNarrationStatesRef, (states) => {
            const current =
              states.get(session.transportSessionId) ?? initialVoiceStreamNarrationState();
            const reduced = reduceVoiceStreamNarration(current, event, streamMode);
            const next = new Map(states);
            next.set(session.transportSessionId, reduced.state);
            return [reduced, next] as const;
          });
          const owner = session.fence.owner;
          if (owner?.kind !== "thread-call") return;
          yield* Effect.forEach(
            update.chunks,
            (chunk) =>
              queueThreadCallSpeech({
                environmentId: session.environmentId,
                threadId: owner.threadId,
                text: chunk.text,
                source: "commentary",
                turnId: chunk.turnId,
                attemptId: `${session.transportSessionId}:${chunk.key}`,
                groupId: `thread-call:${owner.threadId}:turn:${chunk.turnId ?? "pending"}`,
                terminal: chunk.terminal,
              }),
            { discard: true },
          );
        }),
      { discard: true },
    );
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      yield* Effect.forEach(sessions, speechArbiter.cancelAmbient, { discard: true });
      yield* Ref.update(narrationStatesRef, (states) => {
        const next = new Map(states);
        for (const session of sessions) {
          const current = next.get(session.transportSessionId);
          if (current !== undefined)
            next.set(session.transportSessionId, { ...current, pending: null });
        }
        return next;
      });
      return;
    }
    const checkpoint = voiceNarrationCheckpoint(event);
    if (checkpoint === null) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(narrationStatesRef, (states) => {
      const next = new Map(states);
      for (const session of sessions) {
        const current =
          next.get(session.transportSessionId) ?? initialVoiceNarrationRuntimeState(nowMs);
        next.set(session.transportSessionId, { ...current, pending: checkpoint });
      }
      return next;
    });
    yield* Effect.forEach(sessions, attemptThreadCallNarration, { discard: true });
  });

  const narrationTick = Effect.fn("VoiceControllerService.narrationTick")(function* () {
    const sessions = Array.from((yield* transport.getSessions()).values()).filter(
      (session) =>
        session.purpose === "conversation" && session.fence.owner?.kind === "thread-call",
    );
    const activeIds = new Set(sessions.map((session) => session.transportSessionId));
    yield* Ref.update(narrationStatesRef, (states) => {
      const next = new Map(states);
      for (const sessionId of next.keys()) {
        if (!activeIds.has(sessionId)) next.delete(sessionId);
      }
      return next;
    });
    yield* Ref.update(streamNarrationStatesRef, (states) => {
      const next = new Map(states);
      for (const sessionId of next.keys()) {
        if (!activeIds.has(sessionId)) next.delete(sessionId);
      }
      return next;
    });
    yield* Effect.forEach(sessions, attemptThreadCallNarration, { discard: true });
  });

  const narrationFailure = (scope: string) => (cause: Cause<unknown>) =>
    Effect.logWarning("Call narration observer failed", { scope, cause });

  if (Option.isSome(provider)) {
    yield* provider.value.streamEvents.pipe(
      Stream.runForEach((event) =>
        observeNarrationRuntimeEvent(event).pipe(
          Effect.catchCause(narrationFailure("provider-runtime")),
        ),
      ),
      Effect.forkScoped,
    );
  }
  yield* engine.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (
        event.type !== "thread.voice-speech-appended" &&
        event.type !== "thread.voice-exchange-appended"
      ) {
        return Effect.void;
      }
      return markThreadCallSpeech(event.payload.threadId).pipe(
        Effect.catchCause(narrationFailure("voice-speech")),
      );
    }),
    Effect.forkScoped,
  );
  yield* speechArbiter.takeFailure.pipe(
    Effect.flatMap((failure) =>
      recoverVoiceSpeechFailure(
        failure,
        (attempt) =>
          transport
            .emit(attempt.session.fence.clientSessionId, {
              type: "session.error",
              code: "realtime_speech_stalled",
              retryable: true,
            })
            .pipe(Effect.ignore),
        (attempt) =>
          transport
            .stopSession(attempt.session)
            .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.ignore),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* narrationTick().pipe(
    Effect.catchCause(narrationFailure("tick")),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );

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
      let recoveryClaimed = false;
      if (Option.isSome(binding) && binding.value.state === "active") {
        recoveryClaimed = yield* bindings
          .compareAndSetState({
            environmentId: binding.value.environmentId,
            expectedControllerThreadId: binding.value.controllerThreadId,
            expectedBindingGeneration: binding.value.bindingGeneration,
            expectedState: "active",
            nextState: "dormant",
            expectedControlEpoch: binding.value.controlEpoch,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.orElseSucceed(() => false));
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
            .pipe(
              Effect.andThen(transport.stopSession(session)),
              Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT),
              Effect.exit,
            ),
        { discard: true },
      );
      yield* McpSessionRegistry.revokeActiveMcpThread(event.controllerThreadId);
      yield* transport.deleteControllerRuntime(event.controllerThreadId);
      if (Option.isSome(binding) && recoveryClaimed) {
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
              Effect.timeout(CONTROLLER_OPERATION_TIMEOUT),
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
              const activated = yield* bindings
                .compareAndSetState({
                  environmentId: binding.value.environmentId,
                  expectedControllerThreadId: binding.value.controllerThreadId,
                  expectedBindingGeneration: binding.value.bindingGeneration,
                  expectedState: "dormant",
                  nextState: "active",
                  expectedControlEpoch: binding.value.controlEpoch,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                })
                .pipe(Effect.orElseSucceed(() => false));
              if (activated) {
                yield* transport.putControllerRuntime(binding.value.controllerThreadId, {
                  ...restarted.value,
                  controllerThreadId: binding.value.controllerThreadId,
                  modelSelection: lostRuntime.modelSelection,
                });
              } else {
                yield* McpSessionRegistry.revokeActiveMcpThread(binding.value.controllerThreadId);
                yield* runtime
                  .stopControllerRuntime(binding.value.controllerThreadId)
                  .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
              }
            } else {
              yield* runtime
                .stopControllerRuntime(binding.value.controllerThreadId)
                .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
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
        if (session.fence.owner?.kind === "thread-call" && event.role === "user") {
          // The active Call client's WebRTC data channel is authoritative for
          // user finals. The provider runtime mirrors the same utterance with
          // a different item identity and must not trigger barge-in twice.
          return;
        }
        yield* actionRunner.ingestTranscriptDone(session, {
          type: "transcript.done",
          itemId: VoiceTranscriptItemId.make(event.itemId),
          role: event.role,
          text: event.text.slice(0, 120_000),
        });
        return;
      case "transport.item-added": {
        if (!voiceSessionAcceptsHandoffs(session)) return;
        const handoff = yield* parseVoiceHandoffRequest(event.item).pipe(Effect.option);
        if (Option.isNone(handoff)) return;
        if (session.fence.owner?.kind === "thread-call") {
          // WebRTC data-channel handoffs are the authoritative client-managed
          // Call boundary. The app-server may mirror the same delegation with
          // a different normalized item identity; accepting both can duplicate
          // one spoken request in the ordinary thread.
          return;
        }
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

  yield* runtime.streamEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "controller.runtime-lost"
        ? controllerLifecycle.withPermits(1)(handleRuntimeEvent(event))
        : handleRuntimeEvent(event),
    ),
    Effect.forkScoped,
  );

  const settingsChanges = yield* settings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach((nextSettings) =>
      controllerLifecycle.withPermits(1)(
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
                .pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
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
                yield* ensureControllerUnlocked({
                  hostProjectId: binding.value.hostProjectId,
                  providerInstanceId: binding.value.providerInstanceId,
                  authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
                  modelSelection: controller.value.modelSelection,
                }).pipe(Effect.ignore);
              }
            }
          }
          if (policy.realtime && policy.read) return;
          yield* transport.stopAll().pipe(Effect.timeout(CONTROLLER_TEARDOWN_TIMEOUT), Effect.exit);
        }),
      ),
    ),
    Effect.forkScoped,
  );

  return VoiceControllerService.of({
    getActiveCall,
    getController,
    getControllerHistory,
    setControllerTarget,
    ensureController,
    resetController,
    listVoices,
    prepareThreadCall,
    start,
    ingestRealtimeEvent,
    appendAudio,
    stop,
    subscribe,
    speakInThreadCall,
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
  Layer.provide(VoiceSpeechArbiterLive),
);
