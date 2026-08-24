/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderCompactThreadInput,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  ProviderTurnSteerResult,
  TurnId,
} from "@shuv2code/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderDynamicToolsShape } from "./ProviderDynamicTools.ts";
import type { ProviderSyntheticInputShape } from "./ProviderSyntheticInput.ts";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Declares whether the adapter can add input to an existing provider turn
   * without starting or superseding it.
   */
  readonly turnSteering?: "same-turn" | "unsupported";
  /** Declares whether the adapter exposes provider-native manual context compaction. */
  readonly manualCompaction?: boolean;
  /** Decide whether a persisted session cursor represents durable recovery. */
  readonly hasDurableSessionRecovery?: (resumeCursor: unknown) => Effect.Effect<boolean>;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  /**
   * Provider-authoritative persisted turn state, when the adapter exposes it.
   * Absence must never be treated as evidence that a turn is terminal.
   */
  readonly status?: "completed" | "interrupted" | "failed" | "inProgress";
  /**
   * Whether `items` is complete enough for absence checks. Adapters that do
   * not expose this metadata leave it undefined; callers may still use a
   * present exact item as positive evidence.
   */
  readonly itemsView?: "notLoaded" | "summary" | "full";
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderRealtimeStartInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly realtimeSessionId: string;
  readonly model?: string;
  /** WebRTC SDP offer; omit for websocket/PCM transport. */
  readonly offerSdp?: string;
  readonly transportType?: "webrtc" | "websocket";
  readonly voiceId?: string;
  readonly clientManagedHandoffs: true;
  /** Bounded instructions for the realtime conversational front channel. */
  readonly prompt?: string;
  /** Whether Codex should synthesize context from the transport shell. */
  readonly includeStartupContext?: boolean;
  /** Explicit context supplied by the owner of the media session. */
  readonly initialItems?: ReadonlyArray<{
    readonly role: "user" | "developer" | "assistant";
    readonly text: string;
  }>;
}

export interface ProviderRealtimeAudioInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly audioBase64: string;
}

export interface ProviderRealtimeTextInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly text: string;
  readonly role?: "user" | "assistant";
}

export interface ProviderRealtimeSpeechInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly text: string;
}

export interface ProviderRealtimeStopInput {
  readonly threadId: ThreadId;
  readonly generation: number;
}

export interface ProviderRealtimeVoicesResult {
  readonly voices: ReadonlyArray<{ readonly id: string; readonly label?: string }>;
  readonly defaultVoiceId: string | null;
  readonly unsupportedReason?:
    | "feature_disabled"
    | "method_unavailable"
    | "incompatible_version"
    | "empty_voice_catalog";
}

export type ProviderCreationRecoveryInput = Omit<
  ProviderSessionStartInput,
  "resumeCursor" | "recoveryPolicy" | "threadSource"
> & {
  readonly threadSource: string;
};

export type ProviderCreationRecoveryResult =
  | { readonly state: "adopted"; readonly session: ProviderSession }
  | { readonly state: "not_found" }
  | { readonly state: "ambiguous"; readonly candidateCount: number };

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  readonly recoverSessionByThreadSource?: (
    input: ProviderCreationRecoveryInput,
  ) => Effect.Effect<ProviderCreationRecoveryResult, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Add user input to the exact active provider turn.
   */
  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, TError>;

  /**
   * Start the realtime lane on an already-active voice transport session.
   */
  readonly startRealtime?: (input: ProviderRealtimeStartInput) => Effect.Effect<void, TError>;

  readonly appendRealtimeText?: (input: ProviderRealtimeTextInput) => Effect.Effect<void, TError>;

  readonly appendRealtimeSpeech?: (
    input: ProviderRealtimeSpeechInput,
  ) => Effect.Effect<void, TError>;

  readonly appendRealtimeAudio?: (input: ProviderRealtimeAudioInput) => Effect.Effect<void, TError>;

  readonly stopRealtime?: (input: ProviderRealtimeStopInput) => Effect.Effect<void, TError>;

  readonly listRealtimeVoices?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderRealtimeVoicesResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  readonly compactThread?: (input: ProviderCompactThreadInput) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * Session-scoped dynamic tool seam (ADE §3.1). Present only on adapters
   * whose provider supports per-session client-registered tools.
   */
  readonly dynamicTools?: ProviderDynamicToolsShape<TError>;

  /**
   * Session-scoped synthetic input seam (ADE §3.4). Present only on adapters
   * whose provider can accept out-of-band items on a live session.
   */
  readonly syntheticInput?: ProviderSyntheticInputShape<TError>;
}
