import {
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  VoiceCallId,
  VoiceCallRevision,
  VoiceCallState,
  VoiceDeviceIdentity,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { VoiceCall } from "../VoiceControlModels.ts";

export const CreateVoiceCallInput = Schema.Struct({
  callId: VoiceCallId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  activeTransportSessionId: TrimmedNonEmptyString,
  activeDevice: VoiceDeviceIdentity,
  createdAt: IsoDateTime,
});
export type CreateVoiceCallInput = typeof CreateVoiceCallInput.Type;

export type CreateVoiceCallResult =
  | { readonly _tag: "created"; readonly call: VoiceCall }
  | { readonly _tag: "existing"; readonly call: VoiceCall }
  | { readonly _tag: "conflict"; readonly call: VoiceCall | null };

export const CompareAndSetVoiceCallListenerInput = Schema.Struct({
  callId: VoiceCallId,
  expectedRevision: VoiceCallRevision,
  expectedActiveTransportSessionId: Schema.NullOr(TrimmedNonEmptyString),
  threadId: ThreadId,
  state: VoiceCallState,
  activeTransportSessionId: Schema.NullOr(TrimmedNonEmptyString),
  activeDevice: Schema.NullOr(VoiceDeviceIdentity),
  updatedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type CompareAndSetVoiceCallListenerInput = typeof CompareAndSetVoiceCallListenerInput.Type;

export const PromoteVoiceCallListenerInput = Schema.Struct({
  callId: VoiceCallId,
  expectedRevision: VoiceCallRevision,
  expectedActiveTransportSessionId: TrimmedNonEmptyString,
  nextTransportSessionId: TrimmedNonEmptyString,
  nextGeneration: VoiceGeneration,
  nextRuntimeInstanceId: VoiceRuntimeInstanceId,
  nextRealtimeSessionId: VoiceRealtimeSessionId,
  threadId: ThreadId,
  activeDevice: VoiceDeviceIdentity,
  updatedAt: IsoDateTime,
});
export type PromoteVoiceCallListenerInput = typeof PromoteVoiceCallListenerInput.Type;

export interface VoiceCallRepositoryShape {
  readonly create: (
    input: CreateVoiceCallInput,
  ) => Effect.Effect<CreateVoiceCallResult, ProjectionRepositoryError>;
  readonly getById: (
    callId: VoiceCallId,
  ) => Effect.Effect<Option.Option<VoiceCall>, ProjectionRepositoryError>;
  readonly getActiveByEnvironmentId: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<VoiceCall>, ProjectionRepositoryError>;
  readonly compareAndSetListener: (
    input: CompareAndSetVoiceCallListenerInput,
  ) => Effect.Effect<Option.Option<VoiceCall>, ProjectionRepositoryError>;
  readonly promoteListener: (
    input: PromoteVoiceCallListenerInput,
  ) => Effect.Effect<Option.Option<VoiceCall>, ProjectionRepositoryError>;
}

export class VoiceCallRepository extends Context.Service<
  VoiceCallRepository,
  VoiceCallRepositoryShape
>()("@shuv2code/persistence/Services/VoiceCalls/VoiceCallRepository") {}
