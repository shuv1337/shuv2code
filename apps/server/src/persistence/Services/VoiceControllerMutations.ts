import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import {
  VoiceControllerMutation,
  VoiceControllerMutationTerminalState,
} from "../VoiceControlModels.ts";

export const ClaimVoiceControllerMutationInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  mutationKey: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  semanticSlot: TrimmedNonEmptyString,
  canonicalRequestHash: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  providerCreationId: Schema.NullOr(TrimmedNonEmptyString),
  bindingGeneration: PositiveInt,
  controlEpoch: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ClaimVoiceControllerMutationInput = typeof ClaimVoiceControllerMutationInput.Type;

export type ClaimVoiceControllerMutationResult =
  | { readonly _tag: "claimed"; readonly mutation: VoiceControllerMutation }
  | { readonly _tag: "replay"; readonly mutation: VoiceControllerMutation }
  | { readonly _tag: "conflict"; readonly mutation: VoiceControllerMutation | null }
  | { readonly _tag: "action_unavailable" };

export const ClaimVoiceControllerMutationDispatchInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  claimOwner: TrimmedNonEmptyString,
  claimExpiresAt: IsoDateTime,
  claimedAt: IsoDateTime,
  expectedBindingGeneration: PositiveInt,
  expectedControlEpoch: NonNegativeInt,
});
export type ClaimVoiceControllerMutationDispatchInput =
  typeof ClaimVoiceControllerMutationDispatchInput.Type;

export const ReleaseVoiceControllerMutationClaimInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  claimOwner: TrimmedNonEmptyString,
  mayHavePersistedIntents: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ReleaseVoiceControllerMutationClaimInput =
  typeof ReleaseVoiceControllerMutationClaimInput.Type;

export const MarkVoiceControllerMutationDispatchedInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  claimOwner: TrimmedNonEmptyString,
  dispatchedAt: IsoDateTime,
});
export type MarkVoiceControllerMutationDispatchedInput =
  typeof MarkVoiceControllerMutationDispatchedInput.Type;

export const RecordVoiceControllerMutationOutcomeInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  outcome: VoiceControllerMutationTerminalState,
  providerAcknowledgedAt: Schema.NullOr(IsoDateTime),
  outcomeAt: IsoDateTime,
  sanitizedOutcome: Schema.NullOr(Schema.String),
});
export type RecordVoiceControllerMutationOutcomeInput =
  typeof RecordVoiceControllerMutationOutcomeInput.Type;

export const ReconcilePersistedVoiceControllerMutationOutcomeInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  outcome: VoiceControllerMutationTerminalState,
  providerAcknowledgedAt: Schema.NullOr(IsoDateTime),
  outcomeAt: IsoDateTime,
  sanitizedOutcome: Schema.NullOr(Schema.String),
});
export type ReconcilePersistedVoiceControllerMutationOutcomeInput =
  typeof ReconcilePersistedVoiceControllerMutationOutcomeInput.Type;

export const CancelVoiceControllerMutationInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  cancelledAt: IsoDateTime,
  sanitizedOutcome: Schema.NullOr(Schema.String),
});
export type CancelVoiceControllerMutationInput = typeof CancelVoiceControllerMutationInput.Type;

export const CancelVoiceControllerMutationsByPolicyInput = Schema.Struct({
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  throughControlEpoch: NonNegativeInt,
  cancelledAt: IsoDateTime,
  sanitizedOutcome: Schema.NullOr(Schema.String),
});
export type CancelVoiceControllerMutationsByPolicyInput =
  typeof CancelVoiceControllerMutationsByPolicyInput.Type;

export interface VoiceControllerMutationRepositoryShape {
  readonly claimOrReplay: (
    input: ClaimVoiceControllerMutationInput,
  ) => Effect.Effect<ClaimVoiceControllerMutationResult, ProjectionRepositoryError>;
  readonly getByActionId: (
    voiceActionId: string,
  ) => Effect.Effect<Option.Option<VoiceControllerMutation>, ProjectionRepositoryError>;
  readonly getByOperationId: (
    operationId: string,
  ) => Effect.Effect<Option.Option<VoiceControllerMutation>, ProjectionRepositoryError>;
  readonly claimDispatch: (
    input: ClaimVoiceControllerMutationDispatchInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly releaseClaim: (
    input: ReleaseVoiceControllerMutationClaimInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markDispatched: (
    input: MarkVoiceControllerMutationDispatchedInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly recordOutcome: (
    input: RecordVoiceControllerMutationOutcomeInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly reconcilePersistedOutcome: (
    input: ReconcilePersistedVoiceControllerMutationOutcomeInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly cancelNeverDispatchedByPolicy: (
    input: CancelVoiceControllerMutationInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly cancelAllNeverDispatchedByPolicy: (
    input: CancelVoiceControllerMutationsByPolicyInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly listRecoverable: () => Effect.Effect<
    ReadonlyArray<VoiceControllerMutation>,
    ProjectionRepositoryError
  >;
}

export class VoiceControllerMutationRepository extends Context.Service<
  VoiceControllerMutationRepository,
  VoiceControllerMutationRepositoryShape
>()("shuv2code/persistence/Services/VoiceControllerMutations/VoiceControllerMutationRepository") {}
