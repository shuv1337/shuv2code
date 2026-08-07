import { describe, expect, it } from "vite-plus/test";

import {
  initialRealtimeVoiceState,
  reduceRealtimeVoiceState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import { EnvironmentId } from "@shuv2code/contracts";
import { shouldShowVoiceTray, voiceTraySubtitle } from "./VoiceSessionTray";

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
});
