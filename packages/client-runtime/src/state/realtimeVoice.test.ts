import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initialRealtimeVoiceState,
  realtimeVoiceStateLabel,
  reduceRealtimeVoiceState,
} from "./realtimeVoice.ts";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("controller");

describe("realtime voice state", () => {
  it("fences stale generations", () => {
    const started = reduceRealtimeVoiceState(initialRealtimeVoiceState, {
      type: "attempt-started",
      environmentId,
      clientSessionId: "client-session",
      generation: 2,
    });
    const connected = reduceRealtimeVoiceState(started, {
      type: "connected",
      generation: 2,
      controller: {
        environmentId,
        projectId,
        threadId,
        title: "Voice controller",
      },
    });

    expect(
      reduceRealtimeVoiceState(connected, {
        type: "failed",
        generation: 1,
        code: "late",
        message: "A stale attempt failed.",
        recoverable: true,
      }),
    ).toBe(connected);
    expect(realtimeVoiceStateLabel(connected)).toBe("Listening");
  });

  it("keeps final transcript items stable and excludes deltas from sequencing", () => {
    const started = reduceRealtimeVoiceState(initialRealtimeVoiceState, {
      type: "attempt-started",
      environmentId,
      clientSessionId: "client-session",
      generation: 1,
    });
    const delta = reduceRealtimeVoiceState(started, {
      type: "transcript-updated",
      generation: 1,
      item: { id: "utterance", speaker: "user", text: "Start", final: false, sequence: 1 },
    });
    const final = reduceRealtimeVoiceState(delta, {
      type: "transcript-updated",
      generation: 1,
      item: {
        id: "utterance",
        speaker: "user",
        text: "Start the tests",
        final: true,
        sequence: 2,
      },
    });
    const lateDelta = reduceRealtimeVoiceState(final, {
      type: "transcript-updated",
      generation: 1,
      item: { id: "utterance", speaker: "user", text: "Start", final: false, sequence: 3 },
    });

    expect(lateDelta.transcript).toEqual([
      {
        id: "utterance",
        speaker: "user",
        text: "Start the tests",
        final: true,
        sequence: 2,
      },
    ]);
  });

  it("distinguishes accepted actions from provider confirmation", () => {
    const started = reduceRealtimeVoiceState(initialRealtimeVoiceState, {
      type: "attempt-started",
      environmentId,
      clientSessionId: "client-session",
      generation: 1,
    });
    const accepted = reduceRealtimeVoiceState(started, {
      type: "target-updated",
      generation: 1,
      sequence: 3,
      target: {
        environmentId,
        projectId,
        projectTitle: "Project",
        threadId: ThreadId.make("target"),
        threadTitle: "Target",
        actionId: "action",
        accepted: true,
        providerConfirmed: false,
        activeTurnId: TurnId.make("turn"),
        phase: "accepted",
        statusText: "Command accepted",
      },
    });

    expect(accepted.activeTarget).toMatchObject({
      accepted: true,
      providerConfirmed: false,
      activeTurnId: "turn",
    });
    expect(
      reduceRealtimeVoiceState(accepted, {
        type: "target-updated",
        generation: 1,
        sequence: 2,
        target: { ...accepted.activeTarget!, statusText: "stale" },
      }),
    ).toBe(accepted);
  });
});
