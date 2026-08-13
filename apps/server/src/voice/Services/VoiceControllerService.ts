import type {
  VoiceAppendAudioInput,
  VoiceAppendAudioResult,
  VoiceEnsureControllerInput,
  VoiceEnsureControllerResult,
  VoiceGetControllerInput,
  VoiceGetControllerResult,
  VoiceGetControllerHistoryInput,
  VoiceGetControllerHistoryResult,
  VoiceListVoicesInput,
  VoiceListVoicesResult,
  VoiceRealtimeIngressInput,
  VoiceRealtimeIngressResult,
  VoiceResetControllerInput,
  VoiceResetControllerResult,
  VoiceSetControllerTargetInput,
  VoiceSetControllerTargetResult,
  VoiceSessionEvent,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSessionStopInput,
  VoiceSessionStopResult,
  VoiceSubscribeEventsInput,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VoiceControllerError } from "@shuv2code/contracts";

export interface VoiceControllerServiceShape {
  readonly getController: (
    input: VoiceGetControllerInput,
  ) => Effect.Effect<VoiceGetControllerResult, VoiceControllerError>;
  readonly getControllerHistory: (
    input: VoiceGetControllerHistoryInput,
  ) => Effect.Effect<VoiceGetControllerHistoryResult, VoiceControllerError>;
  readonly setControllerTarget: (
    input: VoiceSetControllerTargetInput,
  ) => Effect.Effect<VoiceSetControllerTargetResult, VoiceControllerError>;
  readonly ensureController: (
    input: VoiceEnsureControllerInput,
  ) => Effect.Effect<VoiceEnsureControllerResult, VoiceControllerError>;
  readonly resetController: (
    input: VoiceResetControllerInput,
  ) => Effect.Effect<VoiceResetControllerResult, VoiceControllerError>;
  readonly listVoices: (
    input: VoiceListVoicesInput,
  ) => Effect.Effect<VoiceListVoicesResult, VoiceControllerError>;
  readonly start: (
    input: VoiceSessionStartInput,
  ) => Effect.Effect<VoiceSessionStartResult, VoiceControllerError>;
  readonly ingestRealtimeEvent: (
    input: VoiceRealtimeIngressInput,
  ) => Effect.Effect<VoiceRealtimeIngressResult, VoiceControllerError>;
  readonly appendAudio: (
    input: VoiceAppendAudioInput,
  ) => Effect.Effect<VoiceAppendAudioResult, VoiceControllerError>;
  readonly stop: (
    input: VoiceSessionStopInput,
  ) => Effect.Effect<VoiceSessionStopResult, VoiceControllerError>;
  readonly subscribe: (
    input: VoiceSubscribeEventsInput,
  ) => Stream.Stream<VoiceSessionEvent, VoiceControllerError>;
  /** Queue an explicitly model-authored spoken segment on an active direct Call. */
  readonly speakInThreadCall: (input: {
    readonly environmentId: import("@shuv2code/contracts").EnvironmentId;
    readonly threadId: import("@shuv2code/contracts").ThreadId;
    readonly text: string;
  }) => Effect.Effect<boolean, VoiceControllerError>;
}

export class VoiceControllerService extends Context.Service<
  VoiceControllerService,
  VoiceControllerServiceShape
>()("shuv2code/voice/Services/VoiceControllerService") {}
