import type { CommandId, VoiceControllerError, VoiceTranscriptItemId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ActiveVoiceSession } from "./VoiceTransportCoordinator.ts";

export interface VoiceCallBridgeResult {
  readonly accepted: boolean;
  readonly commandId?: CommandId;
}

/** Keeps realtime Call exchanges and delegated work in one ordinary thread history. */
export interface VoiceCallBridgeShape {
  readonly ingestTranscript: (input: {
    readonly session: ActiveVoiceSession;
    readonly itemId: VoiceTranscriptItemId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly occurredAt: string;
    readonly activeTranscript: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
  }) => Effect.Effect<VoiceCallBridgeResult, VoiceControllerError>;
  readonly delegateUtterance: (input: {
    readonly session: ActiveVoiceSession;
    readonly itemId: VoiceTranscriptItemId;
    readonly text: string;
    readonly occurredAt: string;
    readonly activeTranscript: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
  }) => Effect.Effect<VoiceCallBridgeResult, VoiceControllerError>;
}

export class VoiceCallBridge extends Context.Service<VoiceCallBridge, VoiceCallBridgeShape>()(
  "shuv2code/voice/Services/VoiceCallBridge",
) {}
