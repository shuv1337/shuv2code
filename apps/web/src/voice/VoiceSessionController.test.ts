import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceActionId,
  VoiceCallId,
  VoiceCallRevision,
  VoiceClientSessionId,
  VoiceDeviceId,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  type VoiceSessionEvent,
} from "@shuv2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  parseRealtimeVoiceDataChannelEvent,
  shouldIngestRealtimeVoiceEvent,
  VoiceSessionController,
  type VoiceSessionControllerApi,
} from "./VoiceSessionController";
import type { WebRtcVoiceTransport } from "./WebRtcVoiceTransport";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");
const controllerThreadId = ThreadId.make("controller");
const transportThreadId = ThreadId.make("transport");
const controllerIdentity = {
  controllerThreadId,
  hostProjectId: projectId,
  providerInstanceId,
  authorizedRuntimeCeiling: "approval-required",
  bindingGeneration: 1,
  controlEpoch: 1,
  state: "active",
} as const;
const voiceCatalog = {
  voices: [{ id: "marin", label: "Marin" }],
  defaultVoiceId: "marin",
} as const;

describe("VoiceSessionController", () => {
  it("keeps provider transcription events but drops transcription-only handoffs", () => {
    expect(
      shouldIngestRealtimeVoiceEvent("transcription", {
        type: "transcript.done",
        itemId: "turn-1" as never,
        role: "user",
        text: "Provider transcript",
      }),
    ).toBe(true);
    expect(
      shouldIngestRealtimeVoiceEvent("transcription", {
        type: "handoff",
        handoffId: "handoff-1",
        itemId: "item-1",
        inputTranscript: "Do not invoke the controller",
      }),
    ).toBe(false);
  });

  it("normalizes only bounded final transcripts and client handoffs from the provider channel", () => {
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "input_transcript.added",
          item: {
            id: "turn-1",
            type: "input_transcript",
            text: "Create a thread",
          },
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "turn-1",
      role: "user",
      textDelta: "Create a thread",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "output_transcript.added",
          item: {
            id: "turn-2",
            type: "output_transcript",
            text: "I'll create it.",
          },
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "turn-2",
      role: "assistant",
      textDelta: "I'll create it.",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "output_transcript.added",
          item: { text: "This wire shape has no item identity." },
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "live-assistant",
      role: "assistant",
      textDelta: "This wire shape has no item identity.",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "input_transcript.added",
          item_id: "provider-input-1",
          text: "This is the actual v3 provider shape.",
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "provider-input-1",
      role: "user",
      textDelta: "This is the actual v3 provider shape.",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          response_id: "response-1",
          item_id: "turn-3",
          delta: "I'm checking",
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "turn-3",
      role: "assistant",
      textDelta: "I'm checking",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          response_id: "response-1",
          item_id: "turn-3",
          transcript: "I'm checking the thread now.",
        }),
      ),
    ).toEqual({
      type: "transcript.done",
      itemId: "turn-3",
      role: "assistant",
      text: "I'm checking the thread now.",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "turn-4",
          delta: "Please inspect it",
        }),
      ),
    ).toEqual({
      type: "transcript.delta",
      itemId: "turn-4",
      role: "user",
      textDelta: "Please inspect it",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "turn.done",
          turn: {
            id: "turn-1",
            role: "user",
            transcript: "Create a thread and inspect its status.",
          },
        }),
      ),
    ).toEqual({
      type: "transcript.done",
      itemId: "turn-1",
      role: "user",
      text: "Create a thread and inspect its status.",
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "turn.done",
          turn: { role: "assistant", transcript: "The live response is complete." },
        }),
      ),
    ).toEqual({
      type: "transcript.done",
      itemId: "live-assistant",
      role: "assistant",
      text: "The live response is complete.",
      outputDone: true,
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "turn.done",
          turn_id: "frameless-assistant-turn",
          role: "assistant",
          transcript: "The current Frameless response is complete.",
        }),
      ),
    ).toEqual({
      type: "transcript.done",
      itemId: "frameless-assistant-turn",
      role: "assistant",
      text: "The current Frameless response is complete.",
      outputDone: true,
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "response.created",
          response: { id: "response-started" },
        }),
      ),
    ).toEqual({ type: "output.started", itemId: "response-started" });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "response.done",
          response: { id: "response-completed", status: "completed" },
        }),
      ),
    ).toEqual({ type: "output.done", itemId: "response-completed" });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [
              { type: "input_text", text: "Create a new thread." },
              { type: "input_text", text: "Steer it when it starts." },
            ],
            active_transcript: [
              { role: "user", text: "Can you take care of this?" },
              { role: "assistant", text: "Yes, I'll start now." },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "handoff",
      handoffId: "delegation-1",
      itemId: "delegation-1",
      inputTranscript: "Create a new thread.\nSteer it when it starts.",
      activeTranscript: [
        { role: "user", text: "Can you take care of this?" },
        { role: "assistant", text: "Yes, I'll start now." },
      ],
    });
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-2",
            type: "delegation",
            target: "server",
            content: [{ type: "input_text", text: "Do not relay this." }],
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseRealtimeVoiceDataChannelEvent(
        JSON.stringify({
          type: "turn.done",
          turn: {
            id: "turn-2",
            role: "user",
            transcript: "x".repeat(120_001),
          },
        }),
      ),
    ).toBeUndefined();
    expect(parseRealtimeVoiceDataChannelEvent("not-json")).toBeUndefined();
  });

  it("relays normalized provider events with the complete server-issued fence", async () => {
    const ingress = vi.fn(
      async (
        _environmentId: EnvironmentId,
        _input: Parameters<NonNullable<VoiceSessionControllerApi["ingestRealtimeEvent"]>>[1],
      ) => ({
        accepted: true,
      }),
    );
    const setControllerTarget = vi.fn(async () => ThreadId.make("current-thread"));
    const onMicrophoneStream = vi.fn();
    const onRemoteAudioStream = vi.fn();
    const microphoneStream = {} as MediaStream;
    const remoteAudioStream = {} as MediaStream;
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      setControllerTarget,
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      ingestRealtimeEvent: ingress,
      stop: async () => ({ stopped: true }),
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () =>
        ({
          connect: async ({
            exchangeOffer,
            onData,
            onMicrophoneStream: connectedMicrophone,
            onRemoteAudioStream: connectedRemoteAudio,
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
            onData: (data: string) => void;
            onMicrophoneStream?: (stream: MediaStream) => void | Promise<void>;
            onRemoteAudioStream?: (stream: MediaStream) => void;
          }) => {
            await exchangeOffer("offer");
            await connectedMicrophone?.(microphoneStream);
            connectedRemoteAudio?.(remoteAudioStream);
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item: { id: "turn-1", type: "input_transcript", text: "Create the thread." },
              }),
            );
            onData(
              JSON.stringify({
                type: "turn.done",
                turn: { id: "turn-1", role: "user", transcript: "Create the thread." },
              }),
            );
            onData(
              JSON.stringify({
                type: "delegation.created",
                item: {
                  id: "delegation-1",
                  type: "delegation",
                  target: "client",
                  content: [{ type: "input_text", text: "Create the thread." }],
                },
              }),
            );
          },
          setMuted: () => {},
          close: () => {},
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      targetThreadId: ThreadId.make("current-thread"),
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
      onMicrophoneStream,
      onRemoteAudioStream,
    });
    await vi.waitFor(() => expect(ingress).toHaveBeenCalledTimes(2));
    expect(setControllerTarget).toHaveBeenCalledWith(
      environmentId,
      controllerThreadId,
      ThreadId.make("current-thread"),
    );
    expect(onMicrophoneStream).toHaveBeenCalledWith(microphoneStream);
    expect(onRemoteAudioStream).toHaveBeenCalledWith(remoteAudioStream);
    expect(controller.state.transcript).toContainEqual({
      id: "turn-1",
      speaker: "user",
      text: "Create the thread.",
      final: true,
      sequence: 0,
    });

    const expectedFence = {
      controllerThreadId,
      transportThreadId,
      clientSessionId: "client",
      generation: 1,
      runtimeInstanceId: "runtime",
      realtimeSessionId: "realtime",
    };
    expect(ingress).toHaveBeenNthCalledWith(
      1,
      environmentId,
      expect.objectContaining({
        ...expectedFence,
        event: expect.objectContaining({ type: "transcript.done", itemId: "turn-1" }),
      }),
    );
    expect(ingress).toHaveBeenNthCalledWith(
      2,
      environmentId,
      expect.objectContaining({
        ...expectedFence,
        event: expect.objectContaining({ type: "handoff", handoffId: "delegation-1" }),
      }),
    );
  });

  it("starts an exact-thread Call without ensuring or retargeting a Controller", async () => {
    const callThreadId = ThreadId.make("called-thread");
    let onServerEvent: ((event: VoiceSessionEvent) => void) | null = null;
    const ensureController = vi.fn(async () => {
      throw new Error("Call must not ensure a Controller");
    });
    const setControllerTarget = vi.fn(async () => callThreadId);
    const listVoices = vi.fn(async () => voiceCatalog);
    const ingress = vi.fn(async () => ({ accepted: true }));
    const stop = vi.fn(async () => ({ stopped: true }));
    const start = vi.fn(async (_environmentId, input) => ({
      environmentId,
      owner: input.owner,
      controller: null,
      transportThreadId,
      clientSessionId: input.clientSessionId,
      generation: input.generation,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("call-runtime"),
      realtimeSessionId: VoiceRealtimeSessionId.make("call-realtime"),
      answerSdp: "call-answer",
      transportType: "webrtc" as const,
      eventCursor: VoiceEventSequence.make(0),
    }));
    const controller = new VoiceSessionController({
      api: {
        ensureController,
        setControllerTarget,
        listVoices,
        start,
        ingestRealtimeEvent: ingress,
        stop,
        subscribe: (_environmentId, _input, next) => {
          onServerEvent = next;
          return () => {};
        },
      },
      createTransport: () =>
        ({
          connect: async ({
            exchangeOffer,
            onData,
          }: {
            exchangeOffer: (offerSdp: string) => Promise<string>;
            onData: (data: string) => void;
          }) => {
            await exchangeOffer("call-offer");
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item_id: "call-user-partial",
                text: "Check",
              }),
            );
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item_id: "call-user-revised",
                text: " this thread",
              }),
            );
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item_id: "call-user-duplicate",
                text: " completely.",
              }),
            );
            onData(
              JSON.stringify({
                type: "output_transcript.added",
                item_id: "call-assistant-1",
                text: "I'm checking.",
              }),
            );
            expect(controller.state.transcript).toContainEqual(
              expect.objectContaining({
                speaker: "user",
                text: "Check this thread completely.",
                final: false,
              }),
            );
            expect(ingress).not.toHaveBeenCalled();
            onData(
              JSON.stringify({
                type: "delegation.created",
                item: {
                  id: "call-user-handoff",
                  type: "delegation",
                  target: "client",
                  content: [{ type: "input_text", text: "completely." }],
                },
              }),
            );
            expect(controller.state.transcript).toContainEqual(
              expect.objectContaining({
                speaker: "user",
                text: "Check this thread completely.",
                final: false,
              }),
            );
            expect(ingress).not.toHaveBeenCalled();
            onData(
              JSON.stringify({
                type: "turn.done",
                turn: {
                  id: "call-user-turn",
                  role: "user",
                  transcript: "Check this thread completely.",
                },
              }),
            );
            onData(
              JSON.stringify({
                type: "turn.done",
                turn: {
                  id: "call-assistant-turn",
                  role: "assistant",
                  transcript: "I'm checking.",
                },
              }),
            );
          },
          setMuted: vi.fn(),
          close: vi.fn(),
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "call-client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      owner: { kind: "thread-call", threadId: callThreadId, threadTitle: "Provider recovery" },
      hostProjectId: projectId,
      providerInstanceId,
      modelSelection: {
        instanceId: providerInstanceId,
        model: "gpt-5",
        options: [],
      },
      authorizedRuntimeCeiling: "approval-required",
    });

    expect(ensureController).not.toHaveBeenCalled();
    expect(setControllerTarget).not.toHaveBeenCalled();
    expect(listVoices).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({
        owner: { kind: "thread-call", threadId: callThreadId },
        controllerThreadId: callThreadId,
        transportModelSelection: {
          instanceId: providerInstanceId,
          model: "gpt-5",
          options: [],
        },
        purpose: "conversation",
      }),
    );
    expect(controller.state.owner).toEqual({ kind: "thread-call", threadId: callThreadId });
    expect(controller.state.controller).toEqual({
      environmentId,
      projectId,
      threadId: callThreadId,
      title: "Provider recovery",
    });
    expect(controller.state.transcript).toContainEqual(
      expect.objectContaining({
        speaker: "user",
        text: "Check this thread completely.",
        final: true,
      }),
    );
    expect(controller.state.transcript.filter((item) => item.speaker === "user")).toHaveLength(1);
    expect(controller.state.transcript).not.toContainEqual(
      expect.objectContaining({ speaker: "user", text: " completely.", final: false }),
    );
    expect(controller.state.transcript).toContainEqual(
      expect.objectContaining({ speaker: "assistant", text: "I'm checking.", final: true }),
    );
    await vi.waitFor(() => expect(ingress).toHaveBeenCalledTimes(3));
    expect(onServerEvent).not.toBeNull();
    (onServerEvent as unknown as (event: VoiceSessionEvent) => void)({
      clientSessionId: VoiceClientSessionId.make("call-client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("call-runtime"),
      sequence: VoiceEventSequence.make(1),
      occurredAt: "2026-08-14T00:00:03.000Z",
      payload: {
        type: "transcript.done",
        itemId: "thread-speech:1" as never,
        role: "assistant",
        text: "The deeper thread work is complete.",
        source: "thread",
      },
    });
    expect(controller.state.transcript).toContainEqual(
      expect.objectContaining({
        speaker: "assistant",
        text: "The deeper thread work is complete.",
        final: true,
      }),
    );
    expect(ingress).toHaveBeenCalledTimes(3);
    expect(ingress).toHaveBeenNthCalledWith(
      1,
      environmentId,
      expect.objectContaining({
        owner: { kind: "thread-call", threadId: callThreadId },
        controllerThreadId: callThreadId,
        event: {
          type: "transcript.done",
          itemId: "call-user-partial",
          role: "user",
          text: "Check this thread completely.",
        },
      }),
    );
    expect(ingress).toHaveBeenNthCalledWith(
      2,
      environmentId,
      expect.objectContaining({
        owner: { kind: "thread-call", threadId: callThreadId },
        controllerThreadId: callThreadId,
        event: {
          type: "handoff",
          handoffId: "call-user-handoff",
          itemId: "call-user-partial",
          inputTranscript: "Check this thread completely.",
        },
      }),
    );
    expect(ingress).toHaveBeenNthCalledWith(
      3,
      environmentId,
      expect.objectContaining({
        owner: { kind: "thread-call", threadId: callThreadId },
        controllerThreadId: callThreadId,
        event: {
          type: "transcript.done",
          itemId: "call-assistant-turn",
          role: "assistant",
          text: "I'm checking.",
          outputDone: true,
        },
      }),
    );

    await controller.stop();
    expect(stop).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ owner: { kind: "thread-call", threadId: callThreadId } }),
    );
  });

  it("takes over a Call with the device fence and reconnects by durable Call identity", async () => {
    const callId = VoiceCallId.make("call-1");
    const callThreadId = ThreadId.make("called-thread");
    const start = vi.fn(async (_environmentId, input) => ({
      environmentId,
      owner: input.owner,
      controller: null,
      call: {
        callId,
        environmentId,
        threadId: callThreadId,
        state: "active" as const,
        activeDevice: {
          deviceId: VoiceDeviceId.make("desktop-device"),
          label: "Desktop app",
          kind: "desktop" as const,
        },
        activeTransportSessionId: `${input.clientSessionId}:${input.generation}`,
        revision: VoiceCallRevision.make(input.generation + 4),
        updatedAt: "2026-08-16T01:00:00.000Z",
      },
      transportThreadId,
      clientSessionId: input.clientSessionId,
      generation: input.generation,
      runtimeInstanceId: VoiceRuntimeInstanceId.make(`runtime-${input.generation}`),
      realtimeSessionId: VoiceRealtimeSessionId.make(`realtime-${input.generation}`),
      answerSdp: "answer",
      transportType: "webrtc" as const,
      eventCursor: VoiceEventSequence.make(0),
    }));
    const controller = new VoiceSessionController({
      api: {
        ensureController: vi.fn(async () => {
          throw new Error("Call must not ensure a Controller");
        }),
        listVoices: vi.fn(async () => voiceCatalog),
        start,
        stop: vi.fn(async () => ({ stopped: true })),
        subscribe: () => () => {},
      },
      deviceIdentity: {
        deviceId: VoiceDeviceId.make("desktop-device"),
        label: "Desktop app",
        kind: "desktop",
      },
      createTransport: () =>
        ({
          connect: async ({ exchangeOffer }: { exchangeOffer: (sdp: string) => Promise<string> }) =>
            void (await exchangeOffer("offer")),
          setMuted: vi.fn(),
          close: vi.fn(),
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "desktop-client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      owner: { kind: "thread-call", threadId: callThreadId, threadTitle: "Active thread" },
      takeover: {
        callId,
        expectedRevision: VoiceCallRevision.make(4),
        expectedTransportSessionId: "mobile-client:1",
      },
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });

    expect(start).toHaveBeenNthCalledWith(
      1,
      environmentId,
      expect.objectContaining({
        device: {
          deviceId: "desktop-device",
          label: "Desktop app",
          kind: "desktop",
        },
        takeover: {
          callId: "call-1",
          expectedRevision: 4,
          expectedTransportSessionId: "mobile-client:1",
        },
      }),
    );

    await controller.reconnect();

    expect(start).toHaveBeenNthCalledWith(
      2,
      environmentId,
      expect.objectContaining({ callId: "call-1", device: expect.any(Object) }),
    );
    expect(start.mock.calls[1]?.[1]).not.toHaveProperty("takeover");
  });

  it("keeps a thread Call connected when its next utterance reaches a busy thread", async () => {
    const callThreadId = ThreadId.make("called-thread");
    const stop = vi.fn(async () => ({ stopped: true }));
    const ingress = vi.fn(async (_environmentId, input) => {
      if (input.event.type === "handoff" && input.event.inputTranscript === "Second request") {
        throw {
          code: "controller_busy",
          message: "This thread is already working.",
          retryable: false,
        };
      }
      return { accepted: true };
    });
    const controller = new VoiceSessionController({
      api: {
        ensureController: vi.fn(async () => {
          throw new Error("Call must not ensure a Controller");
        }),
        listVoices: vi.fn(async () => voiceCatalog),
        start: async (_environmentId, input) => ({
          environmentId,
          ...(input.owner === undefined ? {} : { owner: input.owner }),
          controller: null,
          transportThreadId,
          clientSessionId: input.clientSessionId,
          generation: input.generation,
          runtimeInstanceId: VoiceRuntimeInstanceId.make("call-runtime"),
          realtimeSessionId: VoiceRealtimeSessionId.make("call-realtime"),
          answerSdp: "call-answer",
          transportType: "webrtc" as const,
          eventCursor: VoiceEventSequence.make(0),
        }),
        ingestRealtimeEvent: ingress,
        stop,
        subscribe: () => () => {},
      },
      createTransport: () =>
        ({
          connect: async ({
            exchangeOffer,
            onData,
          }: {
            exchangeOffer: (offerSdp: string) => Promise<string>;
            onData: (data: string) => void;
          }) => {
            await exchangeOffer("call-offer");
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item_id: "call-user-1",
                text: "First request",
              }),
            );
            onData(
              JSON.stringify({
                type: "delegation.created",
                item: {
                  id: "call-user-1-complete",
                  type: "delegation",
                  target: "client",
                  content: [{ type: "input_text", text: "First request" }],
                },
              }),
            );
            onData(
              JSON.stringify({
                type: "turn.done",
                turn: { id: "call-user-1-turn", role: "user", transcript: "First request" },
              }),
            );
            onData(
              JSON.stringify({
                type: "output_transcript.added",
                item_id: "call-assistant-1",
                text: "I'm starting that.",
              }),
            );
            onData(
              JSON.stringify({
                type: "input_transcript.added",
                item_id: "call-user-2",
                text: "Second request",
              }),
            );
            onData(
              JSON.stringify({
                type: "delegation.created",
                item: {
                  id: "call-user-2-complete",
                  type: "delegation",
                  target: "client",
                  content: [{ type: "input_text", text: "Second request" }],
                },
              }),
            );
            onData(
              JSON.stringify({
                type: "turn.done",
                turn: { id: "call-user-2-turn", role: "user", transcript: "Second request" },
              }),
            );
          },
          setMuted: vi.fn(),
          close: vi.fn(),
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "call-client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      owner: { kind: "thread-call", threadId: callThreadId, threadTitle: "Provider recovery" },
      hostProjectId: projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5", options: [] },
      authorizedRuntimeCeiling: "approval-required",
    });
    await vi.waitFor(() => expect(ingress).toHaveBeenCalledTimes(4));

    expect(controller.state.phase).toEqual({ type: "connected", activity: "listening" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("shows provider transcription without relaying a handoff or playing agent audio", async () => {
    const ingress = vi.fn(
      async (
        _environmentId: EnvironmentId,
        _input: Parameters<NonNullable<VoiceSessionControllerApi["ingestRealtimeEvent"]>>[1],
      ) => ({ accepted: true }),
    );
    const start = vi.fn(async (_environmentId, input) => ({
      controller: controllerIdentity,
      transportThreadId,
      clientSessionId: input.clientSessionId,
      generation: input.generation,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
      answerSdp: "answer",
      transportType: "webrtc" as const,
      eventCursor: VoiceEventSequence.make(0),
    }));
    const connect = vi.fn(async ({ exchangeOffer, onData, playRemoteAudio }) => {
      expect(playRemoteAudio).toBe(false);
      await exchangeOffer("offer");
      onData(
        JSON.stringify({
          type: "turn.done",
          turn: { id: "turn-1", role: "user", transcript: "This is provider transcription." },
        }),
      );
      onData(
        JSON.stringify({
          type: "output_transcript.added",
          item: { id: "reply-1", type: "output_transcript", text: "This must stay hidden." },
        }),
      );
      onData(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [{ type: "input_text", text: "Do not run this." }],
          },
        }),
      );
    });
    const controller = new VoiceSessionController({
      api: {
        ensureController: async () => ({ controller: controllerIdentity }),
        listVoices: async () => voiceCatalog,
        start,
        ingestRealtimeEvent: ingress,
        stop: async () => ({ stopped: true }),
        subscribe: () => () => {},
      },
      createTransport: () =>
        ({ connect, setMuted: vi.fn(), close: vi.fn() }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
      purpose: "transcription",
    });

    expect(start).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ purpose: "transcription", voiceId: "marin" }),
    );
    expect(controller.state.transcript).toContainEqual(
      expect.objectContaining({ speaker: "user", text: "This is provider transcription." }),
    );
    expect(controller.state.transcript).not.toContainEqual(
      expect.objectContaining({ speaker: "assistant" }),
    );
    expect(ingress).toHaveBeenCalledTimes(1);
    expect(ingress.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ event: expect.objectContaining({ type: "transcript.done" }) }),
    );
  });

  it("fences events and releases the server lease exactly once", async () => {
    let onEvent: ((event: VoiceSessionEvent) => void) | null = null;
    const stop = vi.fn(async () => ({ stopped: true }));
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({
        controller: controllerIdentity,
      }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop,
      subscribe: (_environmentId, input, next) => {
        expect(input.afterSequence).toBe(0);
        onEvent = next;
        return vi.fn();
      },
    };
    const transport = {
      connect: vi.fn(async ({ exchangeOffer }) => {
        await exchangeOffer("offer");
      }),
      setMuted: vi.fn(),
      close: vi.fn(),
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () => transport as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });
    expect(controller.state.phase).toEqual({ type: "connected", activity: "listening" });

    const emit = (event: VoiceSessionEvent) => {
      expect(onEvent).not.toBeNull();
      (onEvent as (value: VoiceSessionEvent) => void)(event);
    };
    emit({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("old-runtime"),
      sequence: VoiceEventSequence.make(1),
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { type: "session.state", state: "assistant-speaking" },
    });
    expect(controller.state.phase).toEqual({ type: "connected", activity: "listening" });

    emit({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      sequence: VoiceEventSequence.make(1),
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { type: "session.state", state: "assistant-speaking" },
    });
    expect(controller.state.phase).toEqual({
      type: "connected",
      activity: "assistant-speaking",
    });

    emit({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      sequence: VoiceEventSequence.make(2),
      occurredAt: "2026-07-30T00:00:01.000Z",
      payload: {
        type: "action.status",
        voiceActionId: VoiceActionId.make("action-1"),
        state: "controller-working",
        statusText: "The controller is reading context or acting.",
      },
    });
    expect(controller.state.controllerAction).toEqual({
      actionId: "action-1",
      sequence: 2,
      state: "controller-working",
      statusText: "The controller is reading context or acting.",
      detailCode: null,
      occurredAt: "2026-07-30T00:00:01.000Z",
    });

    emit({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      sequence: VoiceEventSequence.make(3),
      occurredAt: "2026-07-30T00:00:02.000Z",
      payload: { type: "session.error", code: "controller_runtime_lost", retryable: true },
    });
    await vi.waitFor(() => {
      expect(controller.state.phase).toMatchObject({
        type: "error",
        code: "controller_runtime_lost",
      });
      expect(stop).toHaveBeenCalledTimes(1);
    });

    await controller.stop();
    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(controller.state.phase).toEqual({ type: "idle" });
  });

  it("reconnects with a fresh generation and no recognized utterance payload", async () => {
    const starts: unknown[] = [];
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({
        controller: controllerIdentity,
      }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => {
        starts.push(input);
        return {
          controller: controllerIdentity,
          transportThreadId,
          clientSessionId: input.clientSessionId,
          generation: input.generation,
          runtimeInstanceId: VoiceRuntimeInstanceId.make(`runtime-${input.generation}`),
          realtimeSessionId: VoiceRealtimeSessionId.make(`session-${input.generation}`),
          answerSdp: "answer",
          transportType: "webrtc" as const,
          eventCursor: VoiceEventSequence.make(0),
        };
      },
      stop: async () => ({ stopped: true }),
      subscribe: () => () => {},
    };
    const createTransport = () =>
      ({
        connect: async ({
          exchangeOffer,
        }: {
          exchangeOffer: (offer: string) => Promise<string>;
        }) => {
          await exchangeOffer("offer");
        },
        setMuted: () => {},
        close: () => {},
      }) as unknown as WebRtcVoiceTransport;
    const controller = new VoiceSessionController({
      api,
      createTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    const input = {
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required" as const,
    };

    await controller.start(input);
    await controller.reconnect();

    expect(starts).toMatchObject([
      {
        clientSessionId: "client",
        generation: 1,
        transport: { type: "webrtc", offerSdp: "offer" },
      },
      {
        clientSessionId: "client",
        generation: 2,
        transport: { type: "webrtc", offerSdp: "offer" },
      },
    ]);
    expect(JSON.stringify(starts)).not.toContain("transcript");
    expect(JSON.stringify(starts)).not.toContain("utterance");
  });

  it("resubscribes after a websocket loss without replacing WebRTC or replaying input", async () => {
    const subscriptions: Array<{
      input: Parameters<VoiceSessionControllerApi["subscribe"]>[1];
      onEvent: Parameters<VoiceSessionControllerApi["subscribe"]>[2];
      onError: Parameters<VoiceSessionControllerApi["subscribe"]>[3];
    }> = [];
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop: vi.fn(async () => ({ stopped: true })),
      subscribe: (_environmentId, input, onEvent, onError) => {
        subscriptions.push({ input, onEvent, onError });
        return vi.fn();
      },
    };
    const createTransport = vi.fn(
      () =>
        ({
          connect: async ({
            exchangeOffer,
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
          }) => {
            await exchangeOffer("offer");
          },
          setMuted: () => {},
          close: vi.fn(),
        }) as unknown as WebRtcVoiceTransport,
    );
    const controller = new VoiceSessionController({
      api,
      createTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
      scheduleRetry: (retry) => {
        retry();
        return () => {};
      },
    });
    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });
    subscriptions[0]!.onEvent({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      sequence: VoiceEventSequence.make(5),
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { type: "session.state", state: "listening" },
    });

    subscriptions[0]!.onError(new Error("websocket replaced"));

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.input).toMatchObject({
      clientSessionId: "client",
      generation: 1,
      runtimeInstanceId: "runtime",
      afterSequence: 5,
    });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    expect(JSON.stringify(subscriptions[1]!.input)).not.toContain("utterance");
  });

  it("does not request a microphone when stopped during controller setup", async () => {
    let resolveEnsure!: (value: { controller: typeof controllerIdentity }) => void;
    const ensure = new Promise<{ controller: typeof controllerIdentity }>((resolve) => {
      resolveEnsure = resolve;
    });
    const createTransport = vi.fn();
    const stopMicrophone = vi.fn();
    const microphoneStream = {
      getTracks: () => [{ stop: stopMicrophone }],
    } as unknown as MediaStream;
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ensure,
      listVoices: async () => voiceCatalog,
      start: vi.fn(async () => {
        throw new Error("start should not run");
      }),
      stop: vi.fn(async () => ({ stopped: true })),
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    const starting = controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
      microphoneStream,
    });

    await controller.stop();
    resolveEnsure({ controller: controllerIdentity });
    await starting;

    expect(createTransport).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(stopMicrophone).toHaveBeenCalledTimes(1);
    expect(controller.state.phase).toEqual({ type: "idle" });
  });

  it("probes the v3-compatible voice catalog before requesting a microphone and uses its default", async () => {
    const order: string[] = [];
    const start = vi.fn(async (_environmentId, input) => {
      order.push("start");
      return {
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      };
    });
    const api: VoiceSessionControllerApi = {
      ensureController: async () => {
        order.push("ensure");
        return { controller: controllerIdentity };
      },
      listVoices: async () => {
        order.push("list");
        return voiceCatalog;
      },
      start,
      stop: async () => ({ stopped: true }),
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () => {
        order.push("microphone");
        return {
          connect: async ({
            exchangeOffer,
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
          }) => {
            await exchangeOffer("offer");
          },
          setMuted: () => {},
          close: () => {},
        } as unknown as WebRtcVoiceTransport;
      },
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });

    expect(order).toEqual(["ensure", "list", "microphone", "start"]);
    expect(start).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ voiceId: "marin" }),
    );
  });

  it("surfaces structured catalog unsupported reasons without requesting a microphone", async () => {
    const createTransport = vi.fn();
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => {
        throw {
          code: "method_unavailable",
          message: "thread/realtime/listVoices is unavailable.",
          retryable: false,
        };
      },
      start: vi.fn(),
      stop: vi.fn(async () => ({ stopped: true })),
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });

    expect(controller.state.phase).toEqual({
      type: "unsupported",
      code: "method_unavailable",
      message: "thread/realtime/listVoices is unavailable.",
    });
    expect(createTransport).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("releases a late start result when the user stops during negotiation", async () => {
    let resolveStart!: (value: Awaited<ReturnType<VoiceSessionControllerApi["start"]>>) => void;
    const startResult = new Promise<Awaited<ReturnType<VoiceSessionControllerApi["start"]>>>(
      (resolve) => {
        resolveStart = resolve;
      },
    );
    const stop = vi.fn(async () => ({ stopped: true }));
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async () => startResult,
      stop,
      subscribe: () => () => {},
    };
    const transport = {
      connect: vi.fn(async ({ exchangeOffer }) => {
        await exchangeOffer("offer");
      }),
      setMuted: vi.fn(),
      close: vi.fn(),
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () => transport as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    const starting = controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(1));

    await controller.stop();
    resolveStart({
      controller: controllerIdentity,
      transportThreadId,
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
      answerSdp: "answer",
      transportType: "webrtc" as const,
      eventCursor: VoiceEventSequence.make(0),
    });
    await starting;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({
        clientSessionId: "client",
        generation: 1,
        runtimeInstanceId: "runtime",
      }),
    );
    expect(controller.state.phase).toEqual({ type: "idle" });
  });

  it("closes browser media without a redundant stop RPC when the server stops the session", async () => {
    let onEvent: ((event: VoiceSessionEvent) => void) | null = null;
    const stop = vi.fn(async () => ({ stopped: true }));
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop,
      subscribe: (_environmentId, _input, next) => {
        onEvent = next;
        return vi.fn();
      },
    };
    const transport = {
      connect: vi.fn(async ({ exchangeOffer }) => {
        await exchangeOffer("offer");
      }),
      setMuted: vi.fn(),
      close: vi.fn(),
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () => transport as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });

    onEvent!({
      clientSessionId: VoiceClientSessionId.make("client"),
      generation: VoiceGeneration.make(1),
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
      sequence: VoiceEventSequence.make(1),
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { type: "session.state", state: "stopped" },
    });

    expect(controller.state.phase).toEqual({ type: "idle" });
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps a failed stop retryable and visible until the lease is released", async () => {
    const stop = vi
      .fn<VoiceSessionControllerApi["stop"]>()
      .mockRejectedValueOnce(new Error("socket lost"))
      .mockResolvedValueOnce({ stopped: true });
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop,
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () =>
        ({
          connect: async ({
            exchangeOffer,
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
          }) => {
            await exchangeOffer("offer");
          },
          setMuted: () => {},
          close: () => {},
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });

    await controller.stop();
    expect(controller.state.phase).toMatchObject({
      type: "error",
      recoverable: true,
    });
    await controller.stop();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(controller.state.phase).toEqual({ type: "idle" });
  });

  it("keeps interleaved same-role transcript deltas isolated by item id", async () => {
    let onEvent: ((event: VoiceSessionEvent) => void) | null = null;
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop: async () => ({ stopped: true }),
      subscribe: (_environmentId, _input, next) => {
        onEvent = next;
        return vi.fn();
      },
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () =>
        ({
          connect: async ({
            exchangeOffer,
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
          }) => {
            await exchangeOffer("offer");
          },
          setMuted: () => {},
          close: () => {},
        }) as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });
    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });
    const emitDelta = (sequence: number, itemId: string, textDelta: string) =>
      onEvent!({
        clientSessionId: VoiceClientSessionId.make("client"),
        generation: VoiceGeneration.make(1),
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        sequence: VoiceEventSequence.make(sequence),
        occurredAt: "2026-07-30T00:00:00.000Z",
        payload: {
          type: "transcript.delta",
          itemId: itemId as never,
          role: "assistant",
          textDelta,
        },
      });

    emitDelta(1, "first", "Hel");
    emitDelta(2, "second", "Wor");
    emitDelta(3, "first", "lo");

    expect(controller.state.transcript.find((item) => item.id === "first")?.text).toBe("Hello");
    expect(controller.state.transcript.find((item) => item.id === "second")?.text).toBe("Wor");
  });

  it.each([
    ["microphone-ended", (input: any) => input.onMicrophoneEnded()],
    [
      "autoplay-blocked",
      (input: any) =>
        input.onData(
          JSON.stringify({ type: "client.playback-error", message: "gesture required" }),
        ),
    ],
  ])("closes media and reports %s browser failures", async (code, trigger) => {
    const stop = vi.fn(async () => ({ stopped: true }));
    const transport = {
      connect: vi.fn(async (input) => {
        await input.exchangeOffer("offer");
        trigger(input);
      }),
      setMuted: vi.fn(),
      close: vi.fn(),
    };
    const api: VoiceSessionControllerApi = {
      ensureController: async () => ({ controller: controllerIdentity }),
      listVoices: async () => voiceCatalog,
      start: async (_environmentId, input) => ({
        controller: controllerIdentity,
        transportThreadId,
        clientSessionId: input.clientSessionId,
        generation: input.generation,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime"),
        realtimeSessionId: VoiceRealtimeSessionId.make("realtime"),
        answerSdp: "answer",
        transportType: "webrtc" as const,
        eventCursor: VoiceEventSequence.make(0),
      }),
      stop,
      subscribe: () => () => {},
    };
    const controller = new VoiceSessionController({
      api,
      createTransport: () => transport as unknown as WebRtcVoiceTransport,
      createClientSessionId: () => "client",
      detectSupport: () => ({ supported: true, webrtc: true, pcm: false }),
    });

    await controller.start({
      environmentId,
      hostProjectId: projectId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required",
    });
    await vi.waitFor(() => expect(controller.state.phase).toMatchObject({ type: "error", code }));

    expect(transport.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
