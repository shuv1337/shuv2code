import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VoiceAppendAudioInput,
  VoiceCallPresence,
  VoiceControllerError,
  VoiceGetControllerHistoryResult,
  VoiceGeneration,
  VoiceRealtimeIngressInput,
  VoiceSessionEvent,
  VoiceSessionOwner,
  VoiceTranscriptDeltaEvent,
  VoiceTranscriptDoneEvent,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSubscribeEventsInput,
  resolveVoiceSessionStartTransport,
} from "./realtimeVoice.ts";

const decodeVoiceGetControllerHistoryResult = Schema.decodeUnknownSync(
  VoiceGetControllerHistoryResult,
);
const decodeVoiceCallPresence = Schema.decodeUnknownSync(VoiceCallPresence);
const decodeVoiceSessionStartInput = Schema.decodeUnknownSync(VoiceSessionStartInput);

describe("realtime voice contracts", () => {
  it("models controller, exact-thread Call, and transcription as distinct owners", () => {
    const decodeOwner = Schema.decodeUnknownSync(VoiceSessionOwner);

    expect(decodeOwner({ kind: "controller", controllerThreadId: "controller-1" })).toEqual({
      kind: "controller",
      controllerThreadId: "controller-1",
    });
    expect(decodeOwner({ kind: "thread-call", threadId: "thread-1" })).toEqual({
      kind: "thread-call",
      threadId: "thread-1",
    });
    expect(
      decodeOwner({
        kind: "transcription-test",
        requestId: "request-1",
        providerAnchorThreadId: "anchor-1",
      }),
    ).toEqual({
      kind: "transcription-test",
      requestId: "request-1",
      providerAnchorThreadId: "anchor-1",
    });
  });

  it("rejects owner payloads that mix controller and Call identities", () => {
    expect(() =>
      Schema.decodeUnknownSync(VoiceSessionOwner)({
        kind: "controller",
        controllerThreadId: "controller-1",
        threadId: "thread-1",
      }),
    ).toThrow();
  });

  it("accepts the owner seam without changing the current controller wire", () => {
    const input = decodeVoiceSessionStartInput({
      environmentId: "environment-1",
      owner: { kind: "controller", controllerThreadId: "controller-1" },
      controllerThreadId: "controller-1",
      clientSessionId: "client-session-1",
      generation: 1,
      transport: { type: "webrtc", offerSdp: "v=0\r\n" },
    });

    expect(input.owner).toEqual({ kind: "controller", controllerThreadId: "controller-1" });
    expect(input.controllerThreadId).toBe("controller-1");
  });

  it("represents a direct Call result without fabricating a Controller identity", () => {
    const result = Schema.decodeUnknownSync(VoiceSessionStartResult)({
      environmentId: "environment-1",
      owner: { kind: "thread-call", threadId: "thread-1" },
      controller: null,
      call: {
        callId: "call-1",
        environmentId: "environment-1",
        threadId: "thread-1",
        state: "active",
        activeDevice: { deviceId: "desktop-1", label: "Desktop", kind: "desktop" },
        activeTransportSessionId: "call-session-1:1",
        revision: 1,
        updatedAt: "2026-08-15T23:00:00.000Z",
      },
      transportThreadId: "transport-1",
      clientSessionId: "call-session-1",
      generation: 1,
      runtimeInstanceId: "runtime-1",
      realtimeSessionId: "realtime-1",
      answerSdp: "v=0\r\n",
      transportType: "webrtc",
      eventCursor: 0,
    });

    expect(result.owner).toEqual({ kind: "thread-call", threadId: "thread-1" });
    expect(result.controller).toBeNull();
    expect(result.call?.activeDevice?.label).toBe("Desktop");
  });

  it("models a fenced cross-device Call takeover", () => {
    const input = decodeVoiceSessionStartInput({
      environmentId: "environment-1",
      owner: { kind: "thread-call", threadId: "thread-1" },
      controllerThreadId: "thread-1",
      clientSessionId: "mobile-session-1",
      generation: 1,
      device: { deviceId: "mobile-1", label: "Phone", kind: "mobile" },
      takeover: {
        callId: "call-1",
        expectedRevision: 4,
        expectedTransportSessionId: "desktop-session-1:3",
      },
      transport: { type: "webrtc", offerSdp: "v=0\r\n" },
    });

    expect(input.device?.kind).toBe("mobile");
    expect(input.takeover?.expectedRevision).toBe(4);
    expect(
      decodeVoiceCallPresence({
        callId: "call-1",
        environmentId: "environment-1",
        threadId: "thread-1",
        state: "dormant",
        activeDevice: null,
        activeTransportSessionId: null,
        revision: 5,
        updatedAt: "2026-08-15T23:00:00.000Z",
      }).state,
    ).toBe("dormant");
  });

  it("accepts a generation-fenced WebRTC offer", () => {
    const input = Schema.decodeUnknownSync(VoiceSessionStartInput)({
      controllerThreadId: "controller-1",
      clientSessionId: "client-session-1",
      generation: 1,
      offerSdp: "v=0\r\n",
      voiceId: "verse",
    });

    expect(input.generation).toBe(VoiceGeneration.make(1));
    expect(input.offerSdp).toBe("v=0\r\n");
    expect(resolveVoiceSessionStartTransport(input)).toEqual({
      type: "webrtc",
      offerSdp: "v=0\r\n",
    });
  });

  it("accepts an explicit websocket PCM start transport", () => {
    const input = Schema.decodeUnknownSync(VoiceSessionStartInput)({
      controllerThreadId: "controller-1",
      clientSessionId: "client-session-1",
      generation: 2,
      transport: {
        type: "websocket",
        inputAudio: { format: "pcm16", sampleRateHz: 24_000, channels: 1 },
      },
    });
    expect(resolveVoiceSessionStartTransport(input).type).toBe("websocket");
    const result = Schema.decodeUnknownSync(VoiceSessionStartResult)({
      controller: {
        controllerThreadId: "controller-1",
        hostProjectId: "project-1",
        providerInstanceId: "codex",
        authorizedRuntimeCeiling: "approval-required",
        bindingGeneration: 1,
        controlEpoch: 1,
        state: "active",
      },
      transportThreadId: "transport-1",
      clientSessionId: "client-session-1",
      generation: 2,
      runtimeInstanceId: "runtime-1",
      realtimeSessionId: "realtime-1",
      answerSdp: null,
      transportType: "websocket",
      inputAudio: { format: "pcm16", sampleRateHz: 24_000, channels: 1 },
      eventCursor: 0,
    });
    expect(result.transportType).toBe("websocket");
    expect(result.answerSdp).toBeNull();
  });

  it("keeps realtime transport selection independent from the durable thread", () => {
    const input = decodeVoiceSessionStartInput({
      environmentId: "environment-1",
      owner: { kind: "thread-call", threadId: "durable-thread-1" },
      controllerThreadId: "durable-thread-1",
      clientSessionId: "client-session-1",
      generation: 1,
      transportModelSelection: {
        instanceId: "codex-voice",
        model: "gpt-realtime",
      },
      transport: { type: "webrtc", offerSdp: "v=0\r\n" },
    });

    expect(input.transportModelSelection).toEqual({
      instanceId: "codex-voice",
      model: "gpt-realtime",
    });
    expect(input.owner).toEqual({ kind: "thread-call", threadId: "durable-thread-1" });
  });

  it("accepts an explicit provider-backed transcription session", () => {
    const input = Schema.decodeUnknownSync(VoiceSessionStartInput)({
      controllerThreadId: "controller-1",
      clientSessionId: "transcription-1",
      generation: 1,
      purpose: "transcription",
      transport: {
        type: "websocket",
        inputAudio: { format: "pcm16", sampleRateHz: 24_000, channels: 1 },
      },
    });
    expect(input.purpose).toBe("transcription");
  });

  it("bounds fenced PCM append payloads", () => {
    const input = Schema.decodeUnknownSync(VoiceAppendAudioInput)({
      controllerThreadId: "controller-1",
      transportThreadId: "transport-1",
      clientSessionId: "client-session-1",
      generation: 1,
      runtimeInstanceId: "runtime-1",
      realtimeSessionId: "realtime-1",
      sequence: 1,
      audioBase64: "AAAA",
      format: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
    });
    expect(input.sequence).toBe(1);
    expect(() =>
      Schema.decodeUnknownSync(VoiceAppendAudioInput)({
        ...input,
        sequence: 0,
      }),
    ).toThrow();
  });

  it.each([0, -1, 1.5])("rejects invalid generations: %s", (generation) => {
    expect(() =>
      Schema.decodeUnknownSync(VoiceSubscribeEventsInput)({
        clientSessionId: "client-session-1",
        generation,
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow();
  });

  it("decodes bounded action events without raw provider payloads", () => {
    const event = Schema.decodeUnknownSync(VoiceSessionEvent)({
      clientSessionId: "client-session-1",
      generation: 1,
      runtimeInstanceId: "runtime-1",
      sequence: 4,
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: {
        type: "action.status",
        voiceActionId: "voice-action-1",
        state: "controller-working",
        controllerTurnId: "turn-1",
      },
    });

    expect(event.payload.type).toBe("action.status");
    expect(event).not.toHaveProperty("audio");
    expect(event).not.toHaveProperty("nativePayload");
  });

  it("accepts only bounded realtime data-channel ingress on a complete fence", () => {
    const input = Schema.decodeUnknownSync(VoiceRealtimeIngressInput)({
      controllerThreadId: "controller-1",
      transportThreadId: "transport-1",
      clientSessionId: "client-session-1",
      generation: 1,
      runtimeInstanceId: "runtime-1",
      realtimeSessionId: "realtime-1",
      event: {
        type: "handoff",
        handoffId: "delegation-1",
        itemId: "delegation-1",
        inputTranscript: "Create a thread and report status.",
      },
    });

    expect(input.event.type).toBe("handoff");
    expect(() =>
      Schema.decodeUnknownSync(VoiceRealtimeIngressInput)({
        ...input,
        runtimeInstanceId: undefined,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VoiceRealtimeIngressInput)({
        ...input,
        event: { ...input.event, inputTranscript: "x".repeat(120_001) },
      }),
    ).toThrow();
  });

  it("uses structured, non-sensitive error codes", () => {
    const error = new VoiceControllerError({
      code: "controller_runtime_lost",
      message: "The controller runtime exited.",
      retryable: true,
    });

    expect(error.code).toBe("controller_runtime_lost");
    expect(error.retryable).toBe(true);
  });

  it("rejects oversized transcript payloads at the RPC boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(VoiceTranscriptDeltaEvent)({
        type: "transcript.delta",
        itemId: "item-1",
        role: "user",
        textDelta: "x".repeat(16_385),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VoiceTranscriptDoneEvent)({
        type: "transcript.done",
        itemId: "item-1",
        role: "user",
        text: "x".repeat(120_001),
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(VoiceTranscriptDoneEvent)({
        type: "transcript.done",
        itemId: "thread-speech:1",
        role: "assistant",
        text: "A concise result from the durable thread.",
        source: "thread",
      }),
    ).toMatchObject({ source: "thread" });
    expect(
      Schema.decodeUnknownSync(VoiceRealtimeIngressInput)({
        environmentId: "env-1",
        owner: { kind: "thread-call", threadId: "thread-1" },
        controllerThreadId: "thread-1",
        transportThreadId: "transport-1",
        clientSessionId: "client-1",
        generation: 1,
        runtimeInstanceId: "runtime-1",
        realtimeSessionId: "realtime-1",
        event: { type: "output.done", itemId: "provider-output-1" },
      }),
    ).toMatchObject({ event: { type: "output.done", itemId: "provider-output-1" } });
  });

  it("rejects oversized error messages", () => {
    expect(() =>
      Schema.decodeUnknownSync(VoiceControllerError)({
        _tag: "VoiceControllerError",
        code: "internal_error",
        message: "x".repeat(513),
        retryable: false,
      }),
    ).toThrow();
  });

  it("decodes bounded provider-authoritative controller history", () => {
    const result = decodeVoiceGetControllerHistoryResult({
      controllerThreadId: "voice-controller:1",
      messages: [
        {
          id: "turn-1:user-1",
          turnId: "turn-1",
          role: "user",
          text: "What is the active thread doing?",
        },
        {
          id: "turn-1:assistant",
          turnId: "turn-1",
          role: "assistant",
          text: "It is waiting for approval.",
        },
      ],
    });

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
