import type { RealtimeVoiceSessionState } from "@shuv2code/client-runtime/state/realtime-voice";
import type { EnvironmentId } from "@shuv2code/contracts";

import type { VoiceMediaActivity } from "../../voice/VoiceActivityMonitor";
import type { VoiceSurfaceContext } from "./VoiceSurface";
import type { VoicePresencePhase } from "./voicePresenceTheme";

export interface VoiceCallPresentation {
  readonly sessionHere: boolean;
  readonly environmentId: EnvironmentId;
  readonly context: VoiceSurfaceContext;
}

/**
 * Microphone mute controls only local input. Incoming agent audio and its
 * transcript remain live, so speaking must take precedence over muted
 * presentation whenever either the session or media analyser observes it.
 */
export function resolveVoicePresencePhase(
  sessionHere: boolean,
  phase: RealtimeVoiceSessionState["phase"],
  muted: boolean,
  mediaActivity: VoiceMediaActivity,
): VoicePresencePhase {
  if (!sessionHere || phase.type === "idle") return "idle";
  if (phase.type !== "connected") return "thinking";
  if (phase.activity === "assistant-speaking" || mediaActivity === "assistant-speaking") {
    return "speaking";
  }
  if (phase.activity === "thinking") return "thinking";
  if (muted) return "muted";
  return "listening";
}

/**
 * A Call belongs to its durable Voice owner, not to the currently selected
 * thread. Keep presenting that owner while navigation remounts the surface.
 */
export function resolveVoiceCallPresentation(
  environmentId: EnvironmentId,
  state: RealtimeVoiceSessionState,
  currentContext: VoiceSurfaceContext,
): VoiceCallPresentation {
  const sessionHere = state.owner?.kind === "thread-call";
  if (!sessionHere) return { sessionHere: false, environmentId, context: currentContext };

  const presentation = state.controller;
  if (presentation === null) {
    return {
      sessionHere: true,
      environmentId: state.environmentId ?? environmentId,
      context: currentContext,
    };
  }

  return {
    sessionHere: true,
    environmentId: presentation.environmentId,
    context: {
      ...currentContext,
      threadId: presentation.threadId,
      threadTitle: presentation.title,
      projectTitle:
        currentContext.projectId === presentation.projectId
          ? currentContext.projectTitle
          : "Call project",
      projectId: presentation.projectId,
    },
  };
}
