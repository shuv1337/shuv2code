import type { ThreadId, TurnId, VoiceTranscriptItemId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ActiveVoiceSession } from "./VoiceTransportCoordinator.ts";

export type VoiceSpeechSource = "authored" | "controller" | "catch-up" | "commentary" | "ambient";

export interface VoiceSpeechAttempt {
  readonly attemptId: string;
  readonly source: VoiceSpeechSource;
  readonly session: ActiveVoiceSession;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly requestedText: string;
  readonly requestedAt: string;
  /** Pending speech with the same group is compacted into one current intent. */
  readonly groupId?: string;
  /** A terminal update may evict stale catch-up and progress speech. */
  readonly terminal?: boolean;
}

export interface VoiceSpeechCompletion extends VoiceSpeechAttempt {
  readonly deliveredText: string;
  readonly providerItemId: VoiceTranscriptItemId;
  readonly completedAt: string;
}

export interface VoiceSpeechTranscriptObservation {
  readonly claimed: boolean;
  readonly completion?: VoiceSpeechCompletion;
}

export interface VoiceSpeechArbiterShape {
  readonly enqueue: (attempt: VoiceSpeechAttempt) => Effect.Effect<boolean>;
  /** Blocks until a speech attempt proves the realtime output lifecycle is wedged. */
  readonly takeFailure: Effect.Effect<VoiceSpeechAttempt>;
  readonly observeOutputStarted: (session: ActiveVoiceSession) => Effect.Effect<void>;
  readonly observeOutputDone: (
    session: ActiveVoiceSession,
    occurredAt: string,
  ) => Effect.Effect<VoiceSpeechCompletion | undefined>;
  readonly observeTranscript: (input: {
    readonly session: ActiveVoiceSession;
    readonly itemId: VoiceTranscriptItemId;
    readonly text: string;
    readonly occurredAt: string;
    readonly outputDone: boolean;
  }) => Effect.Effect<VoiceSpeechTranscriptObservation>;
  readonly observeUserSpeech: (session: ActiveVoiceSession) => Effect.Effect<void>;
  readonly cancelAmbient: (session: ActiveVoiceSession) => Effect.Effect<void>;
  readonly close: (session: ActiveVoiceSession) => Effect.Effect<void>;
}

export class VoiceSpeechArbiter extends Context.Service<
  VoiceSpeechArbiter,
  VoiceSpeechArbiterShape
>()("shuv2code/voice/Services/VoiceSpeechArbiter") {}
