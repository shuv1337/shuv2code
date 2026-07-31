import * as Layer from "effect/Layer";

import { VoiceControllerActionRepositoryLive } from "./VoiceControllerActions.ts";
import { VoiceControllerBindingRepositoryLive } from "./VoiceControllerBindings.ts";
import { VoiceControllerMutationRepositoryLive } from "./VoiceControllerMutations.ts";
import { VoiceTransportSessionRepositoryLive } from "./VoiceTransportSessions.ts";

export const VoiceControlPersistenceLayerLive = Layer.mergeAll(
  VoiceControllerBindingRepositoryLive,
  VoiceTransportSessionRepositoryLive,
  VoiceControllerActionRepositoryLive,
  VoiceControllerMutationRepositoryLive,
);
