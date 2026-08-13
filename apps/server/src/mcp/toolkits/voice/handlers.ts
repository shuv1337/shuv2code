import * as Effect from "effect/Effect";

import { VoiceControllerService } from "../../../voice/Services/VoiceControllerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VoiceSpeakError, VoiceToolkit } from "./tools.ts";

export const voiceHandlers = {
  voice_speak: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (!invocation.capabilities.has("voice.speak")) {
        return yield* new VoiceSpeakError({
          reason: "unauthorized",
          message: "This provider session cannot speak into a voice call.",
        });
      }
      const voice = yield* VoiceControllerService;
      const spoken = yield* voice
        .speakInThreadCall({
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
          text: input.text,
        })
        .pipe(
          Effect.mapError(
            () =>
              new VoiceSpeakError({
                reason: "call_not_active",
                message: "The active call is no longer available.",
              }),
          ),
        );
      if (!spoken) {
        return yield* new VoiceSpeakError({
          reason: "call_not_active",
          message: "No active voice call is attached to this thread.",
        });
      }
      return { spoken: true };
    }),
} satisfies Parameters<typeof VoiceToolkit.toLayer>[0];

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer(voiceHandlers);
