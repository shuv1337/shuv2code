import type {
  VoiceAppendAudioInput,
  VoiceAppendAudioResult,
  VoiceEnsureControllerInput,
  VoiceEnsureControllerResult,
  VoiceListVoicesInput,
  VoiceListVoicesResult,
  VoiceRealtimeIngressInput,
  VoiceRealtimeIngressResult,
  VoiceResetControllerInput,
  VoiceResetControllerResult,
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
}

export class VoiceControllerService extends Context.Service<
  VoiceControllerService,
  VoiceControllerServiceShape
>()("@shuv2code/voice/Services/VoiceControllerService") {}
