import type { ThreadId, VoiceActionId, VoiceTargetPhase } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ActiveVoiceSession } from "./VoiceTransportCoordinator.ts";

export interface WatchedVoiceTarget {
  readonly voiceActionId: VoiceActionId;
  readonly transportSessionId: string;
  readonly targetThreadId: ThreadId;
}

export interface VoiceTargetMonitorShape {
  readonly watchTarget: (watch: WatchedVoiceTarget) => Effect.Effect<void>;
  readonly publishWatchedTarget: (watch: WatchedVoiceTarget) => Effect.Effect<void>;
  readonly seedWatchedTargets: (session: ActiveVoiceSession) => Effect.Effect<void>;
  readonly onDomainThreadEvent: (input: {
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<void>;
  readonly claimPhase: (
    watch: WatchedVoiceTarget,
    phase: VoiceTargetPhase,
  ) => Effect.Effect<boolean>;
}

export class VoiceTargetMonitor extends Context.Service<
  VoiceTargetMonitor,
  VoiceTargetMonitorShape
>()("@shuv2code/voice/Services/VoiceTargetMonitor") {}
