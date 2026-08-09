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

  it("surfaces controller work instead of reporting perpetual listening", () => {
    const started = reduceRealtimeVoiceState(initialRealtimeVoiceState, {
      type: "attempt-started",
      environmentId,
      clientSessionId: "client-session",
      generation: 1,
    });
    const connected = reduceRealtimeVoiceState(started, {
      type: "connected",
      generation: 1,
      controller: { environmentId, projectId, threadId, title: "Voice controller" },
    });
    const working = reduceRealtimeVoiceState(connected, {
      type: "controller-action-updated",
      generation: 1,
      sequence: 4,
      action: {
        actionId: "action-1",
        sequence: 4,
        state: "controller-working",
        statusText: "The controller is reading context or acting.",
        detailCode: null,
        occurredAt: "2026-08-09T00:00:00.000Z",
      },
    });

    expect(realtimeVoiceStateLabel(working)).toBe("Voice controller is working");
    expect(working.controllerAction).toMatchObject({
      actionId: "action-1",
      state: "controller-working",
    });

    const withTarget = reduceRealtimeVoiceState(working, {
      type: "target-updated",
      generation: 1,
      sequence: 4,
      target: {
        environmentId,
        projectId,
        projectTitle: "Project",
        threadId: ThreadId.make("target"),
        threadTitle: "Target",
        actionId: "action-1",
        accepted: true,
        providerConfirmed: false,
        activeTurnId: null,
        phase: "accepted",
        statusText: "Accepted.",
      },
    });
    expect(withTarget.controllerAction?.state).toBe("controller-working");
    expect(withTarget.activeTarget?.threadId).toBe("target");

    const completed = reduceRealtimeVoiceState(withTarget, {
      type: "controller-action-updated",
      generation: 1,
      sequence: 5,
      action: {
        ...working.controllerAction!,
        sequence: 5,
        state: "completed",
        statusText: "Done.",
      },
    });
    expect(realtimeVoiceStateLabel(completed)).toBe("Listening");
    expect(completed.controllerAction?.statusText).toBe("Done.");
  });
});
