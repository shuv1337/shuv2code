import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VoiceAppendAudioInput,
  VoiceControllerError,
  VoiceGeneration,
  VoiceRealtimeIngressInput,
  VoiceSessionEvent,
  VoiceTranscriptDeltaEvent,
  VoiceTranscriptDoneEvent,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceSubscribeEventsInput,
  resolveVoiceSessionStartTransport,
} from "./realtimeVoice.ts";

describe("realtime voice contracts", () => {
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
});
