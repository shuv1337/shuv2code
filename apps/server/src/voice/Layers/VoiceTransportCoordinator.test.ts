import { assert, describe, it } from "@effect/vitest";
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
