import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { sanitizeProviderObservabilityEvent } from "./RealtimeObservability.ts";

const secret = "VOICE_SECRET_SHOULD_NEVER_CROSS_OBSERVABILITY";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

describe("RealtimeObservability", () => {
  it("drops every high-risk native and canonical realtime payload class", () => {
    const nativeMethods = [
      "thread/realtime/start",
      "thread/realtime/appendAudio",
      "thread/realtime/appendText",
      "thread/realtime/appendSpeech",
      "thread/realtime/itemAdded",
      "thread/realtime/transcript/delta",
      "thread/realtime/transcript/done",
      "thread/realtime/outputAudio/delta",
      "thread/realtime/sdp",
    ];
    for (const method of nativeMethods) {
      NodeAssert.equal(
        sanitizeProviderObservabilityEvent("native", {
          method,
          payload: { audio: secret, sdp: secret, text: secret, item: secret },
          message: secret,
        }),
        undefined,
      );
    }

    const canonicalTypes = [
      "thread.realtime.item-added",
      "thread.realtime.transcript.delta",
      "thread.realtime.transcript.done",
      "thread.realtime.audio.delta",
      "thread.realtime.sdp",
    ];
    for (const type of canonicalTypes) {
      NodeAssert.equal(
        sanitizeProviderObservabilityEvent("canonical", {
          type,
          payload: { audio: secret, sdp: secret, text: secret, item: secret },
          raw: { payload: secret },
        }),
        undefined,
      );
    }
  });

  it("does not inspect a dropped realtime body", () => {
    const payload = new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        },
      },
    );

    NodeAssert.doesNotThrow(() => {
      NodeAssert.equal(
        sanitizeProviderObservabilityEvent("native", {
          method: "thread/realtime/appendSpeech",
          payload,
        }),
        undefined,
      );
    });
  });

  it("rebuilds lifecycle and error records from an explicit allowlist", () => {
    const started = sanitizeProviderObservabilityEvent("native", {
      id: "event-started",
      kind: "notification",
      provider: "codex",
      providerInstanceId: "codex-personal",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "thread/realtime/started",
      message: secret,
      payload: {
        version: "v3",
        realtimeSessionId: secret,
        answerSdp: secret,
        transcript: secret,
      },
    });
    const closed = sanitizeProviderObservabilityEvent("canonical", {
      eventId: "event-closed",
      provider: "codex",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:01.000Z",
      type: "thread.realtime.closed",
      payload: { reason: secret },
      raw: { payload: { sdp: secret } },
    });
    const error = sanitizeProviderObservabilityEvent("native", {
      method: "thread/realtime/error",
      message: secret,
      payload: {
        code: "protocol_violation",
        message: secret,
        retryable: true,
      },
    });

    NodeAssert.deepEqual(started, {
      method: "thread/realtime/started",
      kind: "notification",
      provider: "codex",
      providerInstanceId: "codex-personal",
      id: "event-started",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lifecycle: {
        state: "started",
        version: "v3",
        hasRealtimeSessionId: true,
      },
    });
    NodeAssert.deepEqual(closed, {
      type: "thread.realtime.closed",
      provider: "codex",
      id: "event-closed",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:01.000Z",
      lifecycle: {
        state: "closed",
        reasonCode: "unknown",
      },
    });
    NodeAssert.deepEqual(error, {
      method: "thread/realtime/error",
      error: {
        code: "protocol_violation",
        retryable: true,
      },
    });

    NodeAssert.equal(encodeUnknownJson({ started, closed, error }).includes(secret), false);
    NodeAssert.deepEqual(
      sanitizeProviderObservabilityEvent(
        "native",
        sanitizeProviderObservabilityEvent("native", {
          method: "thread/realtime/started",
          payload: { version: "v3", realtimeSessionId: "opaque-session" },
        }),
      ),
      {
        method: "thread/realtime/started",
        lifecycle: {
          state: "started",
          version: "v3",
          hasRealtimeSessionId: true,
        },
      },
    );
  });

  it("replaces unrecognized error codes and reasons with fixed enumerated values", () => {
    NodeAssert.deepEqual(
      sanitizeProviderObservabilityEvent("canonical", {
        type: "thread.realtime.error",
        payload: {
          code: secret,
          message: secret,
        },
      }),
      {
        type: "thread.realtime.error",
        error: {
          code: "internal_error",
          retryable: false,
        },
      },
    );
    NodeAssert.deepEqual(
      sanitizeProviderObservabilityEvent("native", {
        method: "thread/realtime/closed",
        payload: { reason: "transport closed" },
      }),
      {
        method: "thread/realtime/closed",
        lifecycle: {
          state: "closed",
          reasonCode: "transport_closed",
        },
      },
    );
  });

  it("passes non-realtime records through unchanged", () => {
    const event = { type: "turn.completed", payload: { state: "completed" } };
    NodeAssert.equal(sanitizeProviderObservabilityEvent("canonical", event), event);
  });

  it("drops unstructured process stderr from voice runtimes", () => {
    const event = {
      method: "process/stderr",
      message: `provider echoed transcript and SDP: ${secret}`,
      payload: { raw: secret },
    };

    NodeAssert.equal(
      sanitizeProviderObservabilityEvent("native", event, { sensitiveRuntime: true }),
      undefined,
    );
    NodeAssert.equal(sanitizeProviderObservabilityEvent("native", event), event);
  });

  it("rebuilds all voice-runtime native and canonical records from fixed lifecycle data", () => {
    const hostileBody = {
      transcript: secret,
      arguments: { token: secret },
      result: { output: secret },
      sdp: secret,
      audio: secret,
      message: secret,
    };
    const droppedNative = sanitizeProviderObservabilityEvent(
      "native",
      {
        method: "item/completed",
        message: secret,
        payload: hostileBody,
      },
      { sensitiveRuntime: true },
    );
    const droppedCanonical = sanitizeProviderObservabilityEvent(
      "canonical",
      {
        type: "item.completed",
        payload: hostileBody,
        raw: { payload: hostileBody },
      },
      { sensitiveRuntime: true },
    );
    const nativeError = sanitizeProviderObservabilityEvent(
      "native",
      {
        method: "error",
        message: secret,
        payload: hostileBody,
      },
      { sensitiveRuntime: true },
    );
    const canonicalLifecycle = sanitizeProviderObservabilityEvent(
      "canonical",
      {
        eventId: "event-exited",
        provider: "codex",
        threadId: "voice-controller:1",
        type: "session.exited",
        payload: {
          state: "stopped",
          reason: secret,
          detail: hostileBody,
        },
        raw: { payload: hostileBody },
      },
      { sensitiveRuntime: true },
    );

    NodeAssert.equal(droppedNative, undefined);
    NodeAssert.equal(droppedCanonical, undefined);
    NodeAssert.deepEqual(nativeError, {
      method: "error",
      error: { code: "internal_error", retryable: false },
    });
    NodeAssert.deepEqual(canonicalLifecycle, {
      provider: "codex",
      id: "event-exited",
      threadId: "voice-controller:1",
      type: "session.exited",
      lifecycle: {
        name: "session.exited",
        state: "stopped",
      },
    });
    const serialized = encodeUnknownJson({ nativeError, canonicalLifecycle });
    NodeAssert.equal(serialized.includes(secret), false);
    NodeAssert.equal(serialized.includes('"raw"'), false);
    NodeAssert.equal(serialized.includes('"payload"'), false);
  });
});
