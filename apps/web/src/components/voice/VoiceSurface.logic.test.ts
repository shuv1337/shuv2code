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

import {
  isVoiceCallContextAvailable,
  resolveVoiceCallContext,
  resolveVoiceCallPresentation,
  resolveVoicePresencePhase,
} from "./VoiceSurface.logic";

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
      projectId: ProjectId.make("project-call"),
    });

    expect(resolved).toEqual({
      sessionHere: true,
      environmentId,
      context: {
        threadId: callThreadId,
        threadTitle: "Original call thread",
        projectTitle: "Project",
        projectId: ProjectId.make("project-call"),
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
    ).toEqual({ sessionHere: false, environmentId, context: currentContext });
  });

  it("keeps a Call visible while viewing a thread in another environment", () => {
    const viewedEnvironmentId = EnvironmentId.make("env-viewed");
    expect(
      resolveVoiceCallPresentation(viewedEnvironmentId, callState, {
        threadId: ThreadId.make("thread-viewed"),
        threadTitle: "Viewed elsewhere",
        projectTitle: "Viewed project",
      }),
    ).toEqual({
      sessionHere: true,
      environmentId,
      context: {
        threadId: callThreadId,
        threadTitle: "Original call thread",
        projectTitle: "Call project",
        projectId: ProjectId.make("project-call"),
      },
    });
  });
});

describe("draft Call context", () => {
  const draftContext = {
    threadId: null,
    threadTitle: "New thread",
    projectTitle: "Project",
    projectId: ProjectId.make("project-draft"),
  };

  it("offers Call actions when the draft can be materialized", () => {
    expect(isVoiceCallContextAvailable(draftContext, async () => draftContext)).toBe(true);
    expect(isVoiceCallContextAvailable(draftContext, undefined)).toBe(false);
  });

  it("materializes a draft before moving a Call onto it", async () => {
    const materialized = {
      ...draftContext,
      threadId: ThreadId.make("thread-materialized"),
    };

    await expect(resolveVoiceCallContext(draftContext, async () => materialized)).resolves.toEqual(
      materialized,
    );
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
