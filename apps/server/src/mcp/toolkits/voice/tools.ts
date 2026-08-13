import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VoiceControllerService } from "../../../voice/Services/VoiceControllerService.ts";

const VoiceSpeechText = Schema.String.annotate({
  description:
    "One concise, independently understandable sentence or short paragraph to speak during the active call.",
}).pipe(Schema.check(Schema.isNonEmpty()), Schema.check(Schema.isMaxLength(2_048)));

export const VoiceSpeakInput = Schema.Struct({ text: VoiceSpeechText });

export const VoiceSpeakResult = Schema.Struct({ spoken: Schema.Boolean });

export class VoiceSpeakError extends Schema.TaggedErrorClass<VoiceSpeakError>()("VoiceSpeakError", {
  reason: Schema.Literals(["unauthorized", "call_not_active"]),
  message: Schema.String,
}) {}

export const VoiceSpeakTool = Tool.make("voice_speak", {
  description:
    "Speak a concise live update in the voice call attached to this exact thread. Use only when this turn's voice-call context says a call is active. Speak natural progress, a clarification, or a compact result; keep code, logs, and detailed prose in the normal response. This does not replace the durable text response.",
  parameters: VoiceSpeakInput,
  success: VoiceSpeakResult,
  failure: VoiceSpeakError,
  dependencies: [McpInvocationContext.McpInvocationContext, VoiceControllerService],
})
  .annotate(Tool.Title, "Speak in active call")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const VoiceToolkit = Toolkit.make(VoiceSpeakTool);
