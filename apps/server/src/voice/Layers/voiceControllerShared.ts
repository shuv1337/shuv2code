import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThreadShell,
  ThreadId,
  VoiceActionId,
  VoiceClientSessionId,
  VoiceControllerError,
  VoiceEventSequence,
  type VoiceControllerIdentity,
  type VoiceTargetPhase,
  type VoiceSessionEvent,
  type VoiceSessionFence,
} from "@shuv2code/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { VoiceControllerMutation } from "../../persistence/VoiceControlModels.ts";
import type { VoiceRuntimeGatewayError } from "../Services/VoiceRuntimeGateway.ts";
import type { ActiveVoiceSession } from "../Services/VoiceTransportCoordinator.ts";
import type { WatchedVoiceTarget } from "../Services/VoiceTargetMonitor.ts";

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
  readonly controllerRuntimeInstanceId: import("@shuv2code/contracts").VoiceRuntimeInstanceId;
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

export const voiceError = (
  code: ConstructorParameters<typeof VoiceControllerError>[0]["code"],
  message: string,
  retryable: boolean,
) => new VoiceControllerError({ code, message, retryable });

export const mapInternalError =
  (code: "internal_error" | "negotiation_failed", message: string) => () =>
    voiceError(code, message, code === "negotiation_failed");

export const mapVoiceCatalogError = (error: VoiceRuntimeGatewayError) => {
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

export function controllerIdentity(binding: {
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

export function fenceMatches(session: ActiveVoiceSession, fence: VoiceSessionFence): boolean {
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

export function voiceTargetStatusText(input: {
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: VoiceTargetPhase;
}): string {
  const projectTitle = input.projectTitle.slice(0, 160);
  const threadTitle = input.threadTitle.slice(0, 160);
  return `Voice target ${JSON.stringify(threadTitle)} in ${JSON.stringify(projectTitle)} is ${input.phase.replaceAll("_", " ")}.`.slice(
    0,
    512,
  );
}

export const domainEventTargetThreadId = (payload: unknown): ThreadId | undefined => {
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
