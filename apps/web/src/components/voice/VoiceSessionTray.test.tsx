import { describe, expect, it } from "vite-plus/test";

import {
  initialRealtimeVoiceState,
  reduceRealtimeVoiceState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import { EnvironmentId, ProjectId, ThreadId } from "@shuv2code/contracts";
import { shouldShowVoiceTray, voiceTraySubtitle, voiceTrayTitle } from "./VoiceSessionTray";

describe("VoiceSessionTray", () => {
  it("stays visible from permission request through actionable errors", () => {
    const requesting = reduceRealtimeVoiceState(initialRealtimeVoiceState, {
      type: "attempt-started",
      clientSessionId: "client",
      generation: 1,
      environmentId: EnvironmentId.make("environment"),
    });
    const failed = reduceRealtimeVoiceState(requesting, {
      type: "failed",
      generation: 1,
      code: "permission-denied",
      message: "Allow microphone access and try again.",
      recoverable: true,
    });

    expect(shouldShowVoiceTray(initialRealtimeVoiceState)).toBe(false);
    expect(shouldShowVoiceTray(requesting)).toBe(true);
    expect(shouldShowVoiceTray(failed)).toBe(true);
    expect(voiceTraySubtitle(failed)).toBe("Needs attention");
  });

  it("names a thread-owned Call without exposing Controller terminology", () => {
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make("thread");
    const callState = {
      ...initialRealtimeVoiceState,
      environmentId,
      owner: { kind: "thread-call" as const, threadId },
      controller: {
        environmentId,
        projectId: ProjectId.make("project"),
        threadId,
        title: "Investigate narration",
      },
    };

    expect(voiceTrayTitle(callState)).toBe("Investigate narration");
    expect(voiceTrayTitle(initialRealtimeVoiceState)).toBe("Voice session");
  });
});
