/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
  ProviderTurnSteerResult,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderCreationRecoveryInput,
  ProviderCreationRecoveryResult,
  ProviderRealtimeAudioInput,
  ProviderRealtimeSpeechInput,
  ProviderRealtimeStartInput,
  ProviderRealtimeStopInput,
  ProviderRealtimeTextInput,
  ProviderRealtimeVoicesResult,
  ProviderThreadSnapshot,
  ProviderThreadHistoryPreparationResult,
} from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  readonly recoverCreatedSession?: (
    input: ProviderCreationRecoveryInput,
  ) => Effect.Effect<ProviderCreationRecoveryResult, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Add input to the exact currently active provider turn.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, ProviderServiceError>;

  readonly startRealtime: (
    input: ProviderRealtimeStartInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly appendRealtimeText: (
    input: ProviderRealtimeTextInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly appendRealtimeSpeech: (
    input: ProviderRealtimeSpeechInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly appendRealtimeAudio: (
    input: ProviderRealtimeAudioInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly stopRealtime: (
    input: ProviderRealtimeStopInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly listRealtimeVoices: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderRealtimeVoicesResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly hasDurableSessionRecovery: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Read the provider's persisted thread history. This may recover the
   * session needed to perform the read, but never starts or replays a turn.
   */
  readonly readThread?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderThreadSnapshot, ProviderServiceError>;

  readonly prepareThreadHistory?: (input: {
    readonly threadId: ThreadId;
    readonly action: "inspect" | "migrate";
  }) => Effect.Effect<ProviderThreadHistoryPreparationResult, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "shuv2code/provider/Services/ProviderService",
) {}
