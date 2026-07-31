import type {
  VoiceActionId,
  VoiceRealtimeIngressInput,
  VoiceRealtimeIngressResult,
  VoiceControllerError,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VoiceHandoffRequest } from "../VoiceHandoffRequest.ts";
import type { ActiveVoiceSession } from "./VoiceTransportCoordinator.ts";

export interface QueuedControllerAction {
  readonly voiceActionId: VoiceActionId;
  readonly sessionId: string;
  readonly transcript: string;
}

export interface VoiceControllerActionRunnerShape {
  readonly enqueueHandoff: (
    session: ActiveVoiceSession,
    handoff: VoiceHandoffRequest,
  ) => Effect.Effect<boolean>;
  readonly ingestRealtimeEvent: (
    input: VoiceRealtimeIngressInput,
  ) => Effect.Effect<VoiceRealtimeIngressResult, VoiceControllerError>;
}

export class VoiceControllerActionRunner extends Context.Service<
  VoiceControllerActionRunner,
  VoiceControllerActionRunnerShape
>()("shuv2code/voice/Services/VoiceControllerActionRunner") {}
