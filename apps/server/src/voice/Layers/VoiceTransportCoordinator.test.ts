import { assert, describe, it } from "@effect/vitest";
import { fenceMatches, publicVoiceSessionId } from "./voiceControllerShared.ts";
import {
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
      answerSdp: "sdp",
      eventCursor: 0,
      history: [],
    };
    assert.strictEqual(fenceMatches(session, fence), true);
    assert.strictEqual(
      fenceMatches(session, { ...fence, generation: VoiceGeneration.make(2) }),
      false,
    );
  });
});
