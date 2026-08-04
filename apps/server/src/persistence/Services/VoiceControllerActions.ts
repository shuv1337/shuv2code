import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { VoiceControllerAction } from "../VoiceControlModels.ts";

export const CreateVoiceControllerActionInput = Schema.Struct({
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
  createdAt: IsoDateTime,
});
export type CreateVoiceControllerActionInput = typeof CreateVoiceControllerActionInput.Type;

export type CreateVoiceControllerActionResult =
  | { readonly _tag: "created"; readonly action: VoiceControllerAction }
  | { readonly _tag: "existing"; readonly action: VoiceControllerAction }
  | { readonly _tag: "conflict"; readonly action: VoiceControllerAction | null };

export const BindVoiceControllerActionTurnInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  controllerProviderSessionId: TrimmedNonEmptyString,
  controllerProviderTurnId: TurnId,
  boundAt: IsoDateTime,
});
export type BindVoiceControllerActionTurnInput = typeof BindVoiceControllerActionTurnInput.Type;

export type BindVoiceControllerActionTurnResult =
  | { readonly _tag: "bound"; readonly action: VoiceControllerAction }
  | { readonly _tag: "existing"; readonly action: VoiceControllerAction }
  | { readonly _tag: "conflict"; readonly action: VoiceControllerAction | null }
  | { readonly _tag: "closed"; readonly action: VoiceControllerAction }
  | { readonly _tag: "not_found" };

export const ResolveVoiceControllerActionTurnInput = Schema.Struct({
  controllerThreadId: ThreadId,
  controllerRuntimeInstanceId: TrimmedNonEmptyString,
  controllerProviderSessionId: TrimmedNonEmptyString,
  controllerProviderTurnId: TurnId,
});
export type ResolveVoiceControllerActionTurnInput =
  typeof ResolveVoiceControllerActionTurnInput.Type;

export const CloseVoiceControllerActionInput = Schema.Struct({
  voiceActionId: TrimmedNonEmptyString,
  terminalState: Schema.Literals(["completed", "cancelled", "failed", "expired"]),
  closedAt: IsoDateTime,
});
export type CloseVoiceControllerActionInput = typeof CloseVoiceControllerActionInput.Type;

export const FenceVoiceControllerActionsInput = Schema.Struct({
  transportSessionId: TrimmedNonEmptyString,
  throughGeneration: PositiveInt,
  closedAt: IsoDateTime,
});
export type FenceVoiceControllerActionsInput = typeof FenceVoiceControllerActionsInput.Type;

export interface VoiceControllerActionRepositoryShape {
  readonly createOrReplay: (
    input: CreateVoiceControllerActionInput,
  ) => Effect.Effect<CreateVoiceControllerActionResult, ProjectionRepositoryError>;
  readonly getById: (
    voiceActionId: string,
  ) => Effect.Effect<Option.Option<VoiceControllerAction>, ProjectionRepositoryError>;
  readonly listByTransportSessionId?: (
    transportSessionId: string,
  ) => Effect.Effect<ReadonlyArray<VoiceControllerAction>, ProjectionRepositoryError>;
  readonly listRecentByControllerThreadId?: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<VoiceControllerAction>, ProjectionRepositoryError>;
  readonly bindControllerTurn: (
    input: BindVoiceControllerActionTurnInput,
  ) => Effect.Effect<BindVoiceControllerActionTurnResult, ProjectionRepositoryError>;
  readonly resolveOpenByControllerTurn: (
    input: ResolveVoiceControllerActionTurnInput,
  ) => Effect.Effect<Option.Option<VoiceControllerAction>, ProjectionRepositoryError>;
  readonly close: (
    input: CloseVoiceControllerActionInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly fenceTransportGeneration: (
    input: FenceVoiceControllerActionsInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class VoiceControllerActionRepository extends Context.Service<
  VoiceControllerActionRepository,
  VoiceControllerActionRepositoryShape
>()("@shuv2code/persistence/Services/VoiceControllerActions/VoiceControllerActionRepository") {}
