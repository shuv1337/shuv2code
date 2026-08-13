import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@shuv2code/contracts";
import * as Schema from "effect/Schema";

export const VoiceControllerBindingState = Schema.Literals([
  "provisioning",
  "active",
  "dormant",
  "resetting",
]);
export type VoiceControllerBindingState = typeof VoiceControllerBindingState.Type;

export const VoiceControllerBinding = Schema.Struct({
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  activeTargetThreadId: Schema.NullOr(ThreadId),
  hostProjectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  authorizedRuntimeCeiling: RuntimeMode,
  bindingGeneration: PositiveInt,
  controlEpoch: NonNegativeInt,
  state: VoiceControllerBindingState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VoiceControllerBinding = typeof VoiceControllerBinding.Type;

export const VoiceTransportSessionState = Schema.Literals([
  "negotiating",
  "active",
  "closing",
  "closed",
  "failed",
  "fenced",
]);
export type VoiceTransportSessionState = typeof VoiceTransportSessionState.Type;

export const VoiceTransportSession = Schema.Struct({
  transportSessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  ownerKind: Schema.Literals(["controller", "thread", "transcription"]),
  ownerId: TrimmedNonEmptyString,
  anchorThreadId: Schema.NullOr(ThreadId),
  /** Compatibility anchor for the Controller coordinator until owner routing is authoritative. */
  controllerThreadId: ThreadId,
  transportThreadId: ThreadId,
  runtimeInstanceId: TrimmedNonEmptyString,
  generation: PositiveInt,
  realtimeSessionId: Schema.NullOr(TrimmedNonEmptyString),
  state: VoiceTransportSessionState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type VoiceTransportSession = typeof VoiceTransportSession.Type;

export const VoiceControllerActionState = Schema.Literals([
  "queued",
  "active",
  "completed",
  "cancelled",
  "failed",
  "expired",
]);
export type VoiceControllerActionState = typeof VoiceControllerActionState.Type;

export const VoiceControllerAction = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  transportSessionId: TrimmedNonEmptyString,
  transportRuntimeInstanceId: TrimmedNonEmptyString,
  transportGeneration: PositiveInt,
  handoffId: TrimmedNonEmptyString,
  handoffItemId: TrimmedNonEmptyString,
  clientUserMessageId: TrimmedNonEmptyString,
  controllerRuntimeInstanceId: TrimmedNonEmptyString,
  controllerProviderSessionId: Schema.NullOr(TrimmedNonEmptyString),
  controllerProviderTurnId: Schema.NullOr(TurnId),
  claimedMutationKey: Schema.NullOr(Schema.String),
  state: VoiceControllerActionState,
  createdAt: IsoDateTime,
  controllerTurnBoundAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
});
export type VoiceControllerAction = typeof VoiceControllerAction.Type;

export const VoiceControllerMutationDispatchState = Schema.Literals([
  "never_dispatched",
  "claimed",
  "dispatched",
  "confirmed",
  "failed",
  "indeterminate",
  "stale",
  "cancelled_by_policy",
]);
export type VoiceControllerMutationDispatchState = typeof VoiceControllerMutationDispatchState.Type;

export const VoiceControllerMutationTerminalState = Schema.Literals([
  "confirmed",
  "failed",
  "indeterminate",
  "stale",
]);
export type VoiceControllerMutationTerminalState = typeof VoiceControllerMutationTerminalState.Type;

export const VoiceControllerMutation = Schema.Struct({
  voiceActionId: Schema.String,
  mutationKey: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  semanticSlot: TrimmedNonEmptyString,
  canonicalRequestHash: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  providerCreationId: Schema.NullOr(TrimmedNonEmptyString),
  bindingGeneration: PositiveInt,
  controlEpoch: NonNegativeInt,
  dispatchState: VoiceControllerMutationDispatchState,
  claimOwner: Schema.NullOr(TrimmedNonEmptyString),
  claimExpiresAt: Schema.NullOr(IsoDateTime),
  claimedAt: Schema.NullOr(IsoDateTime),
  dispatchStartedAt: Schema.NullOr(IsoDateTime),
  providerAcknowledgedAt: Schema.NullOr(IsoDateTime),
  outcomeAt: Schema.NullOr(IsoDateTime),
  sanitizedOutcome: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VoiceControllerMutation = typeof VoiceControllerMutation.Type;
