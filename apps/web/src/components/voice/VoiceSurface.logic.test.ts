import {
  initialRealtimeVoiceState,
  type RealtimeVoiceSessionState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceClientSessionId,
  VoiceGeneration,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceCallPresentation, resolveVoicePresencePhase } from "./VoiceSurface.logic";

const environmentId = EnvironmentId.make("env-voice");
const callThreadId = ThreadId.make("thread-call");

const callState: RealtimeVoiceSessionState = {
  ...initialRealtimeVoiceState,
  clientSessionId: VoiceClientSessionId.make("voice-session"),
  generation: VoiceGeneration.make(1),
  environmentId,
  owner: { kind: "thread-call", threadId: callThreadId },
  phase: { type: "connected", activity: "listening" },
  controller: {
    environmentId,
    projectId: ProjectId.make("project-call"),
    threadId: callThreadId,
    title: "Original call thread",
  },
};

describe("resolveVoiceCallPresentation", () => {
  it("keeps the active call visible after navigating to another thread", () => {
    const resolved = resolveVoiceCallPresentation(environmentId, callState, {
      threadId: ThreadId.make("thread-selected"),
      threadTitle: "Newly selected thread",
      projectTitle: "Project",
    });

    expect(resolved).toEqual({
      sessionHere: true,
      context: {
        threadId: callThreadId,
        threadTitle: "Original call thread",
        projectTitle: "Project",
      },
    });
  });

  it("uses the selected thread when no call is owned by the environment", () => {
    const currentContext = {
      threadId: ThreadId.make("thread-selected"),
      threadTitle: "Selected thread",
      projectTitle: "Project",
    };

    expect(
      resolveVoiceCallPresentation(environmentId, initialRealtimeVoiceState, currentContext),
    ).toEqual({ sessionHere: false, context: currentContext });
  });
});

describe("resolveVoicePresencePhase", () => {
  it("keeps incoming agent speech visible while the microphone is muted", () => {
    expect(
      resolveVoicePresencePhase(
        true,
        { type: "connected", activity: "assistant-speaking" },
        true,
        "assistant-speaking",
      ),
    ).toBe("speaking");
  });

  it("uses remote media activity when session activity lags behind", () => {
    expect(
      resolveVoicePresencePhase(
        true,
        { type: "connected", activity: "listening" },
        true,
        "assistant-speaking",
      ),
    ).toBe("speaking");
  });

  it("shows muted only while no incoming agent speech is active", () => {
    expect(
      resolveVoicePresencePhase(
        true,
        { type: "connected", activity: "listening" },
        true,
        "listening",
      ),
    ).toBe("muted");
  });
});
