import { assert, describe, it } from "@effect/vitest";
import { boundedCallInitialItems, CALL_REALTIME_PROMPT } from "./VoiceTransportCoordinator.ts";
import { fenceMatches, publicVoiceSessionId } from "./voiceControllerShared.ts";
import {
  EnvironmentId,
  ThreadId,
  VoiceClientSessionId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";

describe("VoiceTransportCoordinator ownership", () => {
  it("hydrates realtime from bounded completed ordinary-thread messages", () => {
    const items = boundedCallInitialItems([
      { role: "user", text: "older", streaming: false },
      { role: "assistant", text: "partial", streaming: true },
      { role: "assistant", text: "latest", streaming: false },
    ]);
    assert.deepStrictEqual(items, [
      { role: "user", text: "older" },
      { role: "assistant", text: "latest" },
    ]);
  });

  it("keeps ordinary contextual conversation on the realtime side of a Call", () => {
    assert.include(CALL_REALTIME_PROMPT, "primary realtime conversational voice");
    assert.include(CALL_REALTIME_PROMPT, "questions about them do not require a handoff");
    assert.include(CALL_REALTIME_PROMPT, "short, incomplete, or trailing utterance");
    assert.include(CALL_REALTIME_PROMPT, "Ask one brief spoken clarification");
    assert.include(CALL_REALTIME_PROMPT, "do not hand off a fragment");
    assert.include(CALL_REALTIME_PROMPT, "A handoff extends this same live call");
  });

  it("keys public session identity by client session id", () => {
    const clientSessionId = VoiceClientSessionId.make("browser-1");
    assert.strictEqual(publicVoiceSessionId({ fence: { clientSessionId } }), clientSessionId);
  });

  it("requires full fence equality before transport mutation", () => {
    const fence = {
      environmentId: EnvironmentId.make("env"),
      owner: {
        kind: "controller" as const,
        controllerThreadId: ThreadId.make("controller"),
      },
      controllerThreadId: ThreadId.make("controller"),
      transportThreadId: ThreadId.make("transport"),
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
    };
    const session = {
      fence,
      transportSessionId: "client:1",
      environmentId: "env" as never,
      hostProjectId: "project" as never,
      providerInstanceId: "codex" as never,
      controller: {} as never,
      controllerRuntime: {} as never,
      transportType: "webrtc" as const,
      purpose: "conversation" as const,
      answerSdp: "sdp",
      lastAudioSequence: 0,
      eventCursor: 0,
      history: [],
    };
    assert.strictEqual(fenceMatches(session, fence), true);
    assert.strictEqual(
      fenceMatches(session, { ...fence, generation: VoiceGeneration.make(2) }),
      false,
    );
    assert.strictEqual(
      fenceMatches(session, {
        ...fence,
        owner: { kind: "controller", controllerThreadId: ThreadId.make("other-controller") },
      }),
      false,
    );
    assert.strictEqual(
      fenceMatches(session, { ...fence, environmentId: EnvironmentId.make("other-env") }),
      false,
    );
  });
});
