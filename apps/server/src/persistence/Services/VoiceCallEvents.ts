import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  VoiceCallId,
  VoiceDeviceId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";
import { VoiceCallEvent, VoiceCallEventKind } from "../VoiceControlModels.ts";

export const AppendVoiceCallEventInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  callId: Schema.optionalKey(Schema.NullOr(VoiceCallId)),
  deviceId: Schema.optionalKey(Schema.NullOr(VoiceDeviceId)),
  transportSessionId: TrimmedNonEmptyString,
  generation: PositiveInt,
  kind: VoiceCallEventKind,
  correlationId: Schema.NullOr(TrimmedNonEmptyString),
  threadSnapshotSequence: Schema.NullOr(NonNegativeInt),
  payload: Schema.Unknown,
  occurredAt: IsoDateTime,
});
export type AppendVoiceCallEventInput = typeof AppendVoiceCallEventInput.Type;

export interface VoiceCallEventRepositoryShape {
  readonly append: (
    input: AppendVoiceCallEventInput,
  ) => Effect.Effect<VoiceCallEvent, ProjectionRepositoryError>;
  readonly getLatestListenerEvent: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<VoiceCallEvent>, ProjectionRepositoryError>;
  readonly listByThreadId: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly afterEventId?: number;
  }) => Effect.Effect<ReadonlyArray<VoiceCallEvent>, ProjectionRepositoryError>;
}

export class VoiceCallEventRepository extends Context.Service<
  VoiceCallEventRepository,
  VoiceCallEventRepositoryShape
>()("shuv2code/persistence/Services/VoiceCallEvents/VoiceCallEventRepository") {}
