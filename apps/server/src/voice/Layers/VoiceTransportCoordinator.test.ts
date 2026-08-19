import { assert, describe, it } from "@effect/vitest";
import {
  boundedCallInitialItems,
  callIdentityInitialItem,
  CALL_REALTIME_PROMPT,
  sameVoiceTransportGeneration,
} from "./VoiceTransportCoordinator.ts";
import { fenceMatches, publicVoiceSessionId } from "./voiceControllerShared.ts";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
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
    assert.include(CALL_REALTIME_PROMPT, "one short, complete, context-specific sentence");
    assert.include(CALL_REALTIME_PROMPT, "names the next step");
    assert.include(CALL_REALTIME_PROMPT, "Never use a bare status filler");
    assert.include(CALL_REALTIME_PROMPT, "authoritative Call attachment");
    assert.include(CALL_REALTIME_PROMPT, "Never guess these identities");
  });

  it("supplies authoritative durable and transport identities to Realtime", () => {
    const item = callIdentityInitialItem({
      thread: {
        id: ThreadId.make("thread-luna"),
        title: "Identify Running Durable Agent",
        projectId: ProjectId.make("project-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode-go/gpt-5.6-luna",
          options: [{ id: "agent", value: "build" }],
        },
      },
      transportModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-live-1-codex",
      },
    });
    assert.strictEqual(item.role, "developer");
    assert.include(item.text, "Durable provider instance: opencode");
    assert.include(item.text, "Durable model: opencode-go/gpt-5.6-luna");
    assert.include(item.text, "Durable agent/profile: build");
    assert.include(item.text, "Realtime voice transport model: gpt-live-1-codex");
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
      transportProviderInstanceId: "codex" as never,
      controller: {} as never,
      controllerRuntime: {} as never,
      call: null,
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
    assert.strictEqual(sameVoiceTransportGeneration(session, session), true);
    assert.strictEqual(
      sameVoiceTransportGeneration({ ...session, transportSessionId: "client:2" }, session),
      false,
    );
    assert.strictEqual(
      sameVoiceTransportGeneration(
        {
          ...session,
          fence: { ...fence, generation: VoiceGeneration.make(2) },
        },
        session,
      ),
      false,
    );
  });
});
