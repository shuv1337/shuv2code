import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceActionId,
  VoiceClientSessionId,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  type VoiceSessionEvent,
} from "@shuv2code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  parseRealtimeVoiceDataChannelEvent,
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
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [
              { type: "input_text", text: "Create a new thread." },
              { type: "input_text", text: "Steer it when it starts." },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "handoff",
      handoffId: "delegation-1",
      itemId: "delegation-1",
      inputTranscript: "Create a new thread.\nSteer it when it starts.",
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
    const ingress = vi.fn(async () => ({ accepted: true }));
    const setControllerTarget = vi.fn(async () => ThreadId.make("current-thread"));
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
          }: {
            exchangeOffer: (offer: string) => Promise<string>;
            onData: (data: string) => void;
          }) => {
            await exchangeOffer("offer");
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
    });
    await vi.waitFor(() => expect(ingress).toHaveBeenCalledTimes(2));
    expect(setControllerTarget).toHaveBeenCalledWith(
      environmentId,
      controllerThreadId,
      ThreadId.make("current-thread"),
    );
    expect(controller.state.transcript).toContainEqual({
      id: "client:user:1",
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
