import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const makeVoiceId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(Schema.brand(brand));

export const VoiceClientSessionId = makeVoiceId("VoiceClientSessionId");
export type VoiceClientSessionId = typeof VoiceClientSessionId.Type;

export const VoiceActionId = makeVoiceId("VoiceActionId");
export type VoiceActionId = typeof VoiceActionId.Type;

export const VoiceRuntimeInstanceId = makeVoiceId("VoiceRuntimeInstanceId");
export type VoiceRuntimeInstanceId = typeof VoiceRuntimeInstanceId.Type;

export const VoiceRealtimeSessionId = makeVoiceId("VoiceRealtimeSessionId");
export type VoiceRealtimeSessionId = typeof VoiceRealtimeSessionId.Type;

export const VoiceTranscriptItemId = makeVoiceId("VoiceTranscriptItemId");
export type VoiceTranscriptItemId = typeof VoiceTranscriptItemId.Type;

export const VoiceGeneration = PositiveInt.pipe(Schema.brand("VoiceGeneration"));
export type VoiceGeneration = typeof VoiceGeneration.Type;

export const VoiceEventSequence = NonNegativeInt.pipe(Schema.brand("VoiceEventSequence"));
export type VoiceEventSequence = typeof VoiceEventSequence.Type;

export const VoiceControllerState = Schema.Literals([
  "provisioning",
  "active",
  "dormant",
  "resetting",
]);
export type VoiceControllerState = typeof VoiceControllerState.Type;

export const VoiceControllerIdentity = Schema.Struct({
  controllerThreadId: ThreadId,
  hostProjectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  authorizedRuntimeCeiling: RuntimeMode,
  bindingGeneration: NonNegativeInt,
  controlEpoch: NonNegativeInt,
  state: VoiceControllerState,
});
export type VoiceControllerIdentity = typeof VoiceControllerIdentity.Type;

export const VoiceEnsureControllerInput = Schema.Struct({
  hostProjectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  /**
   * Exact live selection from the Codex thread that launched voice. The
   * server validates it against the bound provider's current model catalog.
   */
  modelSelection: Schema.optionalKey(ModelSelection),
  authorizedRuntimeCeiling: RuntimeMode,
});
export type VoiceEnsureControllerInput = typeof VoiceEnsureControllerInput.Type;

export const VoiceEnsureControllerResult = Schema.Struct({
  controller: VoiceControllerIdentity,
});
export type VoiceEnsureControllerResult = typeof VoiceEnsureControllerResult.Type;

export const VoiceGetControllerInput = Schema.Struct({});
export type VoiceGetControllerInput = typeof VoiceGetControllerInput.Type;

export const VoiceGetControllerResult = Schema.Struct({
  controller: Schema.NullOr(VoiceControllerIdentity),
});
export type VoiceGetControllerResult = typeof VoiceGetControllerResult.Type;

export const VoiceControllerHistoryMessage = Schema.Struct({
  id: makeVoiceId("VoiceControllerHistoryMessageId"),
  turnId: TurnId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120_000)),
});
export type VoiceControllerHistoryMessage = typeof VoiceControllerHistoryMessage.Type;

export const VoiceGetControllerHistoryInput = Schema.Struct({
  controllerThreadId: ThreadId,
});
export type VoiceGetControllerHistoryInput = typeof VoiceGetControllerHistoryInput.Type;

export const VoiceGetControllerHistoryResult = Schema.Struct({
  controllerThreadId: ThreadId,
  messages: Schema.Array(VoiceControllerHistoryMessage),
});
export type VoiceGetControllerHistoryResult = typeof VoiceGetControllerHistoryResult.Type;

export const VoiceResetControllerInput = Schema.Struct({
  controllerThreadId: ThreadId,
});
export type VoiceResetControllerInput = typeof VoiceResetControllerInput.Type;

export const VoiceResetControllerResult = Schema.Struct({
  reset: Schema.Boolean,
});
export type VoiceResetControllerResult = typeof VoiceResetControllerResult.Type;

export const VoiceListVoicesInput = Schema.Struct({
  controllerThreadId: ThreadId,
});
export type VoiceListVoicesInput = typeof VoiceListVoicesInput.Type;

export const VoiceDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceDescriptor = typeof VoiceDescriptor.Type;

export const VoiceListVoicesResult = Schema.Struct({
  voices: Schema.Array(VoiceDescriptor),
  defaultVoiceId: Schema.NullOr(TrimmedNonEmptyString),
});
export type VoiceListVoicesResult = typeof VoiceListVoicesResult.Type;

const SessionDescriptionSdp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(262_144));

/** Hard ceiling for one base64-encoded PCM input chunk (decoded ≤ 64 KiB). */
export const VOICE_PCM_MAX_ENCODED_CHUNK_CHARS = 87_384;
/** Hard ceiling for one base64-encoded PCM output chunk. */
export const VOICE_PCM_MAX_OUTPUT_ENCODED_CHUNK_CHARS = 87_384;
export const VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ = 24_000;
export const VOICE_PCM_DEFAULT_CHANNELS = 1;

export const VoiceAudioFormat = Schema.Literals(["pcm16", "g711_ulaw", "g711_alaw"]);
export type VoiceAudioFormat = typeof VoiceAudioFormat.Type;

export const VoiceAudioMetadata = Schema.Struct({
  format: VoiceAudioFormat,
  sampleRateHz: PositiveInt,
  channels: PositiveInt,
});
export type VoiceAudioMetadata = typeof VoiceAudioMetadata.Type;

export const VoiceWebrtcStartTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  offerSdp: SessionDescriptionSdp,
});
export type VoiceWebrtcStartTransport = typeof VoiceWebrtcStartTransport.Type;

export const VoiceWebsocketStartTransport = Schema.Struct({
  type: Schema.Literal("websocket"),
  inputAudio: VoiceAudioMetadata,
});
export type VoiceWebsocketStartTransport = typeof VoiceWebsocketStartTransport.Type;

export const VoiceSessionStartTransport = Schema.Union([
  VoiceWebrtcStartTransport,
  VoiceWebsocketStartTransport,
]);
export type VoiceSessionStartTransport = typeof VoiceSessionStartTransport.Type;

/**
 * Start a fenced voice session. Prefer WebRTC when available; websocket/PCM is
 * the negotiated fallback. Legacy clients may still send top-level `offerSdp`.
 */
export const VoiceSessionStartInput = Schema.Struct({
  controllerThreadId: ThreadId,
  clientSessionId: VoiceClientSessionId,
  generation: VoiceGeneration,
  /** @deprecated Prefer `transport: { type: "webrtc", offerSdp }`. */
  offerSdp: Schema.optionalKey(SessionDescriptionSdp),
  transport: Schema.optionalKey(VoiceSessionStartTransport),
  voiceId: Schema.optionalKey(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter((input) => {
    if (input.transport !== undefined) return true;
    if (input.offerSdp !== undefined && input.offerSdp.length > 0) return true;
    return "Either transport or legacy offerSdp is required.";
  }),
);
export type VoiceSessionStartInput = typeof VoiceSessionStartInput.Type;

export const resolveVoiceSessionStartTransport = (
  input: VoiceSessionStartInput,
): VoiceSessionStartTransport => {
  if (input.transport !== undefined) return input.transport;
  if (input.offerSdp !== undefined && input.offerSdp.length > 0) {
    return { type: "webrtc", offerSdp: input.offerSdp };
  }
  throw new Error("Voice session start is missing transport.");
};

export const VoiceSessionStartResult = Schema.Struct({
  controller: VoiceControllerIdentity,
  transportThreadId: ThreadId,
  clientSessionId: VoiceClientSessionId,
  generation: VoiceGeneration,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  realtimeSessionId: VoiceRealtimeSessionId,
  /** Present for WebRTC sessions; null for websocket/PCM. */
  answerSdp: Schema.NullOr(SessionDescriptionSdp),
  transportType: Schema.Literals(["webrtc", "websocket"]),
  /** Server-advertised input audio format for websocket sessions. */
  inputAudio: Schema.optionalKey(VoiceAudioMetadata),
  /**
   * Last event sequence committed before this response. A fresh subscriber
   * passes this value as `afterSequence`; only newer events are delivered.
   */
  eventCursor: VoiceEventSequence,
});
export type VoiceSessionStartResult = typeof VoiceSessionStartResult.Type;

export const VoiceSessionFence = Schema.Struct({
  controllerThreadId: ThreadId,
  transportThreadId: ThreadId,
  clientSessionId: VoiceClientSessionId,
  generation: VoiceGeneration,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  realtimeSessionId: VoiceRealtimeSessionId,
});
export type VoiceSessionFence = typeof VoiceSessionFence.Type;

/**
 * Fenced, monotonically sequenced PCM input. Ephemeral — must not enter durable
 * VoiceSessionEvent history, projections, NDJSON, or generic RPC logs.
 */
export const VoiceAppendAudioInput = Schema.Struct({
  ...VoiceSessionFence.fields,
  sequence: PositiveInt,
  audioBase64: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(VOICE_PCM_MAX_ENCODED_CHUNK_CHARS),
  ),
  format: VoiceAudioFormat,
  sampleRateHz: PositiveInt,
  channels: PositiveInt,
});
export type VoiceAppendAudioInput = typeof VoiceAppendAudioInput.Type;

export const VoiceAppendAudioResult = Schema.Struct({
  accepted: Schema.Boolean,
  /** Present when accepted is false. */
  code: Schema.optionalKey(
    Schema.Literals([
      "stale_generation",
      "out_of_order",
      "overload",
      "session_not_found",
      "unsupported_transport",
      "chunk_too_large",
    ]),
  ),
});
export type VoiceAppendAudioResult = typeof VoiceAppendAudioResult.Type;

export const VoiceSessionStopInput = VoiceSessionFence;
export type VoiceSessionStopInput = typeof VoiceSessionStopInput.Type;

export const VoiceSessionStopResult = Schema.Struct({
  stopped: Schema.Boolean,
});
export type VoiceSessionStopResult = typeof VoiceSessionStopResult.Type;

export const VoiceRealtimeTranscriptIngressEvent = Schema.Struct({
  type: Schema.Literal("transcript.done"),
  itemId: VoiceTranscriptItemId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(120_000)),
});

export const VoiceRealtimeHandoffIngressEvent = Schema.Struct({
  type: Schema.Literal("handoff"),
  handoffId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  itemId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  inputTranscript: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
});

export const VoiceRealtimeIngressEvent = Schema.Union([
  VoiceRealtimeTranscriptIngressEvent,
  VoiceRealtimeHandoffIngressEvent,
]);
export type VoiceRealtimeIngressEvent = typeof VoiceRealtimeIngressEvent.Type;

/**
 * Authenticated browser ingress for the provider's direct WebRTC data channel.
 * Every event is bound to the complete server-issued transport fence.
 */
export const VoiceRealtimeIngressInput = Schema.Struct({
  ...VoiceSessionFence.fields,
  event: VoiceRealtimeIngressEvent,
});
export type VoiceRealtimeIngressInput = typeof VoiceRealtimeIngressInput.Type;

export const VoiceRealtimeIngressResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type VoiceRealtimeIngressResult = typeof VoiceRealtimeIngressResult.Type;

export const VoiceSubscribeEventsInput = Schema.Struct({
  clientSessionId: VoiceClientSessionId,
  generation: VoiceGeneration,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  afterSequence: Schema.optionalKey(VoiceEventSequence),
});
export type VoiceSubscribeEventsInput = typeof VoiceSubscribeEventsInput.Type;

export const VoiceTransportState = Schema.Literals([
  "negotiating",
  "listening",
  "user-speaking",
  "thinking",
  "assistant-speaking",
  "reconnecting",
  "stopping",
  "stopped",
]);
export type VoiceTransportState = typeof VoiceTransportState.Type;

export const VoiceActionState = Schema.Literals([
  "queued",
  "controller-starting",
  "controller-working",
  "accepted",
  "provider-confirmed",
  "completed",
  "failed",
  "stale",
  "indeterminate",
  "superseded",
]);
export type VoiceActionState = typeof VoiceActionState.Type;

export const VoiceTargetPhase = Schema.Literals([
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
  "starting",
  "working",
  "interrupted",
  "completed",
  "ready",
  "stopped",
  "stale",
]);
export type VoiceTargetPhase = typeof VoiceTargetPhase.Type;

export const VoiceUnsupportedCode = Schema.Literals([
  "feature_disabled",
  "method_unavailable",
  "incompatible_version",
  "empty_voice_catalog",
  "webrtc_unavailable",
]);
export type VoiceUnsupportedCode = typeof VoiceUnsupportedCode.Type;

export const VoiceErrorCode = Schema.Literals([
  ...VoiceUnsupportedCode.literals,
  "controller_not_found",
  "controller_binding_conflict",
  "controller_runtime_lost",
  "controller_busy",
  "generation_conflict",
  "stale_generation",
  "protocol_violation",
  "negotiation_failed",
  "session_not_found",
  "permission_denied",
  "internal_error",
]);
export type VoiceErrorCode = typeof VoiceErrorCode.Type;

export class VoiceControllerError extends Schema.TaggedErrorClass<VoiceControllerError>()(
  "VoiceControllerError",
  {
    code: VoiceErrorCode,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
    retryable: Schema.Boolean,
  },
) {}

export const VoiceSessionStateEvent = Schema.Struct({
  type: Schema.Literal("session.state"),
  state: VoiceTransportState,
});

export const VoiceTranscriptDeltaEvent = Schema.Struct({
  type: Schema.Literal("transcript.delta"),
  itemId: VoiceTranscriptItemId,
  role: Schema.Literals(["user", "assistant"]),
  textDelta: Schema.String.check(Schema.isMaxLength(16_384)),
});

export const VoiceTranscriptDoneEvent = Schema.Struct({
  type: Schema.Literal("transcript.done"),
  itemId: VoiceTranscriptItemId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(120_000)),
});

export const VoiceActionStatusEvent = Schema.Struct({
  type: Schema.Literal("action.status"),
  voiceActionId: VoiceActionId,
  state: VoiceActionState,
  controllerTurnId: Schema.optionalKey(TurnId),
  targetThreadId: Schema.optionalKey(ThreadId),
  targetProjectId: Schema.optionalKey(ProjectId),
  projectTitle: Schema.optionalKey(TrimmedNonEmptyString),
  threadTitle: Schema.optionalKey(TrimmedNonEmptyString),
  statusText: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  detailCode: Schema.optionalKey(TrimmedNonEmptyString),
});

export const VoiceTargetStatusEvent = Schema.Struct({
  type: Schema.Literal("target.status"),
  voiceActionId: VoiceActionId,
  targetThreadId: ThreadId,
  targetProjectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  phase: VoiceTargetPhase,
  statusText: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  activeTurnId: Schema.NullOr(TurnId),
  snapshotSequence: NonNegativeInt,
  observedAt: IsoDateTime,
});

export const VoiceSessionErrorEvent = Schema.Struct({
  type: Schema.Literal("session.error"),
  code: VoiceErrorCode,
  retryable: Schema.Boolean,
});

/**
 * Ephemeral output audio for websocket transport. Not durable history —
 * delivered only on the live subscribe stream for the current generation.
 */
export const VoiceOutputAudioDeltaEvent = Schema.Struct({
  type: Schema.Literal("audio.output.delta"),
  sequence: PositiveInt,
  audioBase64: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(VOICE_PCM_MAX_OUTPUT_ENCODED_CHUNK_CHARS),
  ),
  format: VoiceAudioFormat,
  sampleRateHz: PositiveInt,
  channels: PositiveInt,
});

export const VoiceSessionEventPayload = Schema.Union([
  VoiceSessionStateEvent,
  VoiceTranscriptDeltaEvent,
  VoiceTranscriptDoneEvent,
  VoiceActionStatusEvent,
  VoiceTargetStatusEvent,
  VoiceSessionErrorEvent,
  VoiceOutputAudioDeltaEvent,
]);
export type VoiceSessionEventPayload = typeof VoiceSessionEventPayload.Type;

export const VoiceSessionEvent = Schema.Struct({
  clientSessionId: VoiceClientSessionId,
  generation: VoiceGeneration,
  runtimeInstanceId: VoiceRuntimeInstanceId,
  sequence: VoiceEventSequence,
  occurredAt: IsoDateTime,
  payload: VoiceSessionEventPayload,
});
export type VoiceSessionEvent = typeof VoiceSessionEvent.Type;
