import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { VoiceControllerBinding, VoiceControllerBindingState } from "../VoiceControlModels.ts";

export const ReserveVoiceControllerBindingInput = Schema.Struct({
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  hostProjectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  authorizedRuntimeCeiling: RuntimeMode,
  bindingGeneration: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  controlEpoch: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ReserveVoiceControllerBindingInput = typeof ReserveVoiceControllerBindingInput.Type;

export type ReserveVoiceControllerBindingResult =
  | { readonly _tag: "created"; readonly binding: VoiceControllerBinding }
  | { readonly _tag: "existing"; readonly binding: VoiceControllerBinding }
  | { readonly _tag: "conflict"; readonly binding: VoiceControllerBinding };

export const CompareAndSetVoiceControllerBindingStateInput = Schema.Struct({
  environmentId: EnvironmentId,
  expectedControllerThreadId: ThreadId,
  expectedBindingGeneration: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedState: VoiceControllerBindingState,
  nextState: VoiceControllerBindingState,
  expectedControlEpoch: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type CompareAndSetVoiceControllerBindingStateInput =
  typeof CompareAndSetVoiceControllerBindingStateInput.Type;

export const DeleteResettingVoiceControllerBindingInput = Schema.Struct({
  environmentId: EnvironmentId,
  expectedControllerThreadId: ThreadId,
  expectedBindingGeneration: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type DeleteResettingVoiceControllerBindingInput =
  typeof DeleteResettingVoiceControllerBindingInput.Type;

export const RotateVoiceControllerControlEpochInput = Schema.Struct({
  environmentId: EnvironmentId,
  expectedControlEpoch: NonNegativeInt,
  nextControlEpoch: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type RotateVoiceControllerControlEpochInput =
  typeof RotateVoiceControllerControlEpochInput.Type;

export const IncrementVoiceControllerControlEpochInput = Schema.Struct({
  environmentId: EnvironmentId,
  expectedControlEpoch: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type IncrementVoiceControllerControlEpochInput =
  typeof IncrementVoiceControllerControlEpochInput.Type;

export type IncrementVoiceControllerControlEpochResult =
  | { readonly _tag: "incremented"; readonly controlEpoch: number }
  | { readonly _tag: "conflict" };

export const SetVoiceControllerActiveTargetInput = Schema.Struct({
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  expectedControlEpoch: NonNegativeInt,
  activeTargetThreadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});
export type SetVoiceControllerActiveTargetInput = typeof SetVoiceControllerActiveTargetInput.Type;

export const ClearVoiceControllerActiveTargetInput = Schema.Struct({
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  expectedControlEpoch: NonNegativeInt,
  expectedActiveTargetThreadId: ThreadId,
  updatedAt: IsoDateTime,
});
export type ClearVoiceControllerActiveTargetInput =
  typeof ClearVoiceControllerActiveTargetInput.Type;

export interface VoiceControllerBindingRepositoryShape {
  readonly reserve: (
    input: ReserveVoiceControllerBindingInput,
  ) => Effect.Effect<ReserveVoiceControllerBindingResult, ProjectionRepositoryError>;
  readonly getByEnvironmentId: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<VoiceControllerBinding>, ProjectionRepositoryError>;
  readonly getByControllerThreadId: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<VoiceControllerBinding>, ProjectionRepositoryError>;
  readonly compareAndSetState: (
    input: CompareAndSetVoiceControllerBindingStateInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly rotateControlEpoch: (
    input: RotateVoiceControllerControlEpochInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly incrementControlEpoch: (
    input: IncrementVoiceControllerControlEpochInput,
  ) => Effect.Effect<IncrementVoiceControllerControlEpochResult, ProjectionRepositoryError>;
  readonly setActiveTarget: (
    input: SetVoiceControllerActiveTargetInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly clearActiveTargetIfMatches: (
    input: ClearVoiceControllerActiveTargetInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly deleteResetting: (
    input: DeleteResettingVoiceControllerBindingInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class VoiceControllerBindingRepository extends Context.Service<
  VoiceControllerBindingRepository,
  VoiceControllerBindingRepositoryShape
>()("@shuv2code/persistence/Services/VoiceControllerBindings/VoiceControllerBindingRepository") {}
