import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { VoiceTransportSession, VoiceTransportSessionState } from "../VoiceControlModels.ts";

export const OpenVoiceTransportSessionInput = Schema.Struct({
  transportSessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  controllerThreadId: ThreadId,
  transportThreadId: ThreadId,
  runtimeInstanceId: TrimmedNonEmptyString,
  generation: PositiveInt,
  createdAt: IsoDateTime,
});
export type OpenVoiceTransportSessionInput = typeof OpenVoiceTransportSessionInput.Type;

export type OpenVoiceTransportSessionResult =
  | { readonly _tag: "created"; readonly session: VoiceTransportSession }
  | { readonly _tag: "existing"; readonly session: VoiceTransportSession }
  | { readonly _tag: "conflict"; readonly session: VoiceTransportSession | null };

export const ActivateVoiceTransportSessionInput = Schema.Struct({
  transportSessionId: TrimmedNonEmptyString,
  generation: PositiveInt,
  runtimeInstanceId: TrimmedNonEmptyString,
  realtimeSessionId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ActivateVoiceTransportSessionInput = typeof ActivateVoiceTransportSessionInput.Type;

export const CompareAndSetVoiceTransportSessionStateInput = Schema.Struct({
  transportSessionId: TrimmedNonEmptyString,
  generation: PositiveInt,
  runtimeInstanceId: TrimmedNonEmptyString,
  expectedState: VoiceTransportSessionState,
  nextState: VoiceTransportSessionState,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type CompareAndSetVoiceTransportSessionStateInput =
  typeof CompareAndSetVoiceTransportSessionStateInput.Type;

export const FenceVoiceTransportGenerationInput = Schema.Struct({
  controllerThreadId: ThreadId,
  throughGeneration: PositiveInt,
  fencedAt: IsoDateTime,
});
export type FenceVoiceTransportGenerationInput = typeof FenceVoiceTransportGenerationInput.Type;

export interface VoiceTransportSessionRepositoryShape {
  readonly openOrReplay: (
    input: OpenVoiceTransportSessionInput,
  ) => Effect.Effect<OpenVoiceTransportSessionResult, ProjectionRepositoryError>;
  readonly getById: (
    transportSessionId: string,
  ) => Effect.Effect<Option.Option<VoiceTransportSession>, ProjectionRepositoryError>;
  readonly getOpenByControllerThreadId: (
    controllerThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<VoiceTransportSession>, ProjectionRepositoryError>;
  readonly activate: (
    input: ActivateVoiceTransportSessionInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly compareAndSetState: (
    input: CompareAndSetVoiceTransportSessionStateInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly fenceGeneration: (
    input: FenceVoiceTransportGenerationInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class VoiceTransportSessionRepository extends Context.Service<
  VoiceTransportSessionRepository,
  VoiceTransportSessionRepositoryShape
>()("shuv2code/persistence/Services/VoiceTransportSessions/VoiceTransportSessionRepository") {}
