/**
 * Builds the only realtime records that may cross an observability boundary.
 *
 * Realtime media and text remain available to the authorized in-memory voice
 * pipeline. They must never reach durable provider logs, spans, analytics, or
 * error annotations. Lifecycle records are rebuilt instead of redacted in
 * place so an unexpected field cannot survive a schema or protocol change.
 */

export type ProviderObservabilityStream = "native" | "canonical" | "orchestration";

export interface ProviderObservabilityOptions {
  /**
   * Marks an event as originating from a voice transport or controller
   * runtime. Provider stderr is not structured and may echo SDP, transcripts,
   * or tool arguments, so it is omitted entirely for these runtimes.
   */
  readonly sensitiveRuntime?: boolean;
}

const REALTIME_PREFIX = "thread/realtime/";
const CANONICAL_REALTIME_PREFIX = "thread.realtime.";

const realtimeErrorCodes = new Set([
  "feature_disabled",
  "method_unavailable",
  "incompatible_version",
  "empty_voice_catalog",
  "webrtc_unavailable",
  "controller_not_found",
  "controller_binding_conflict",
  "controller_runtime_lost",
  "controller_busy",
  "generation_conflict",
  "stale_generation",
  "protocol_violation",
  "negotiation_failed",
  "session_not_found",
  "permission_denied",
  "internal_error",
]);

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

interface RealtimeSignal {
  readonly kind: "started" | "closed" | "error" | "sensitive";
  readonly name: string;
}

const sensitiveCanonicalLifecycleTypes = new Set([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
]);

const sensitiveNativeLifecycleMethods = new Map<string, string>([
  ["session/closed", "session.closed"],
  ["thread/started", "thread.started"],
  ["turn/started", "turn.started"],
  ["turn/completed", "turn.completed"],
  ["turn/aborted", "turn.aborted"],
]);

const safeLifecycleStates = new Set([
  "starting",
  "started",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "stopped",
  "closed",
  "error",
]);

function readUnknown(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readString(value: unknown, key: PropertyKey): string | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function readBoolean(value: unknown, key: PropertyKey): boolean | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function safeIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && safeIdentifierPattern.test(value) ? value : undefined;
}

function safeIsoDate(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 64 || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function realtimeSignal(event: unknown): RealtimeSignal | undefined {
  const method = readString(event, "method");
  if (method?.startsWith(REALTIME_PREFIX)) {
    switch (method) {
      case "thread/realtime/started":
        return { kind: "started", name: method };
      case "thread/realtime/closed":
        return { kind: "closed", name: method };
      case "thread/realtime/error":
        return { kind: "error", name: method };
      default:
        return { kind: "sensitive", name: method };
    }
  }

  const type = readString(event, "type");
  if (type?.startsWith(CANONICAL_REALTIME_PREFIX)) {
    switch (type) {
      case "thread.realtime.started":
        return { kind: "started", name: type };
      case "thread.realtime.closed":
        return { kind: "closed", name: type };
      case "thread.realtime.error":
        return { kind: "error", name: type };
      default:
        return { kind: "sensitive", name: type };
    }
  }

  return undefined;
}

function structuralBase(event: unknown, signal: RealtimeSignal): Record<string, unknown> {
  const method = readString(event, "method");
  const type = readString(event, "type");
  const kind = safeIdentifier(readString(event, "kind"));
  const provider = safeIdentifier(readString(event, "provider"));
  const providerInstanceId = safeIdentifier(readString(event, "providerInstanceId"));
  const eventId = safeIdentifier(readString(event, "id") ?? readString(event, "eventId"));
  const threadId = safeIdentifier(readString(event, "threadId"));
  const turnId = safeIdentifier(readString(event, "turnId"));
  const createdAt = safeIsoDate(readString(event, "createdAt"));

  return {
    ...(method === signal.name ? { method } : {}),
    ...(type === signal.name ? { type } : {}),
    ...(kind ? { kind } : {}),
    ...(provider ? { provider } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(eventId ? { id: eventId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function readPayload(event: unknown): unknown {
  return readUnknown(event, "payload") ?? readUnknown(event, "params");
}

function readRealtimeErrorCode(event: unknown): string {
  const payload = readPayload(event);
  const sanitizedError = readUnknown(event, "error");
  const nestedError = readUnknown(payload, "error");
  const candidates = [
    readString(event, "code"),
    readString(payload, "code"),
    readString(nestedError, "code"),
    readString(sanitizedError, "code"),
  ];
  return (
    candidates.find((candidate) => candidate && realtimeErrorCodes.has(candidate)) ??
    "internal_error"
  );
}

function readClosedReasonCode(event: unknown): string {
  const payload = readPayload(event);
  const lifecycle = readUnknown(event, "lifecycle");
  const explicitCode =
    readString(payload, "reasonCode") ??
    readString(payload, "code") ??
    readString(lifecycle, "reasonCode");
  if (
    explicitCode &&
    (realtimeErrorCodes.has(explicitCode) ||
      explicitCode === "completed" ||
      explicitCode === "stopped" ||
      explicitCode === "transport_closed" ||
      explicitCode === "unknown")
  ) {
    return explicitCode;
  }

  switch ((readString(payload, "reason") ?? "").trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "stopped":
    case "client stopped":
    case "client_stop":
    case "server stopped":
    case "server_stop":
      return "stopped";
    case "transport closed":
    case "transport_closed":
      return "transport_closed";
    case "runtime lost":
    case "runtime_lost":
      return "controller_runtime_lost";
    case "protocol violation":
    case "protocol_violation":
      return "protocol_violation";
    default:
      return "unknown";
  }
}

function sanitizeRealtimeLifecycle(event: unknown, signal: RealtimeSignal): unknown {
  const payload = readPayload(event);
  const base = structuralBase(event, signal);

  switch (signal.kind) {
    case "started": {
      const lifecycle = readUnknown(event, "lifecycle");
      const version = readString(payload, "version") ?? readString(lifecycle, "version");
      const realtimeSessionId = readString(payload, "realtimeSessionId");
      const hasRealtimeSessionId =
        readBoolean(lifecycle, "hasRealtimeSessionId") ?? Boolean(realtimeSessionId);
      return {
        ...base,
        lifecycle: {
          state: "started",
          ...(version === "v1" || version === "v2" || version === "v3" ? { version } : {}),
          hasRealtimeSessionId,
        },
      };
    }
    case "closed":
      return {
        ...base,
        lifecycle: {
          state: "closed",
          reasonCode: readClosedReasonCode(event),
        },
      };
    case "error": {
      const sanitizedError = readUnknown(event, "error");
      const retryable =
        readBoolean(payload, "retryable") ??
        readBoolean(event, "retryable") ??
        readBoolean(sanitizedError, "retryable") ??
        false;
      return {
        ...base,
        error: {
          code: readRealtimeErrorCode(event),
          retryable,
        },
      };
    }
    case "sensitive":
      return undefined;
  }
}

function sensitiveStructuralBase(event: unknown): Record<string, unknown> {
  const provider = safeIdentifier(readString(event, "provider"));
  const providerInstanceId = safeIdentifier(readString(event, "providerInstanceId"));
  const eventId = safeIdentifier(readString(event, "id") ?? readString(event, "eventId"));
  const threadId = safeIdentifier(readString(event, "threadId"));
  const turnId = safeIdentifier(readString(event, "turnId"));
  const createdAt = safeIsoDate(readString(event, "createdAt"));

  return {
    ...(provider ? { provider } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(eventId ? { id: eventId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function readFixedLifecycleState(event: unknown): string | undefined {
  const payload = readPayload(event);
  const candidates = [
    readString(payload, "state"),
    readString(payload, "status"),
    readString(payload, "exitKind"),
  ];
  return candidates.find((candidate) => candidate && safeLifecycleStates.has(candidate));
}

/**
 * Voice runtimes are privileged, transcript-bearing control planes. Rebuild
 * their records from fixed lifecycle names instead of trying to redact raw
 * provider-shaped objects. This deliberately drops item, content, request,
 * tool, account, config, and metadata events in full.
 */
function sanitizeSensitiveRuntimeEvent(
  stream: Exclude<ProviderObservabilityStream, "orchestration">,
  event: unknown,
): unknown | undefined {
  const signal = realtimeSignal(event);
  if (signal) {
    return sanitizeRealtimeLifecycle(event, signal);
  }

  const base = sensitiveStructuralBase(event);
  if (stream === "native") {
    const method = readString(event, "method");
    if (method === "process/stderr") return undefined;
    if (method === "error") {
      return {
        ...base,
        method,
        error: { code: "internal_error", retryable: false },
      };
    }
    const lifecycle = method ? sensitiveNativeLifecycleMethods.get(method) : undefined;
    if (!lifecycle) return undefined;
    const state = readFixedLifecycleState(event);
    return {
      ...base,
      method,
      lifecycle: {
        name: lifecycle,
        ...(state ? { state } : {}),
      },
    };
  }

  const type = readString(event, "type");
  if (type === "runtime.error" || type === "runtime.warning") {
    return {
      ...base,
      type,
      error: { code: "internal_error", retryable: false },
    };
  }
  if (!type || !sensitiveCanonicalLifecycleTypes.has(type)) return undefined;
  const state = readFixedLifecycleState(event);
  return {
    ...base,
    type,
    lifecycle: {
      name: type,
      ...(state ? { state } : {}),
    },
  };
}

/**
 * Returns an observability-safe event, or `undefined` when the record must be
 * omitted. Non-realtime records are passed through unchanged.
 */
export function sanitizeProviderObservabilityEvent(
  stream: ProviderObservabilityStream,
  event: unknown,
  options?: ProviderObservabilityOptions,
): unknown | undefined {
  if (stream === "orchestration") return event;
  if (options?.sensitiveRuntime === true) {
    return sanitizeSensitiveRuntimeEvent(stream, event);
  }
  const signal = realtimeSignal(event);
  return signal ? sanitizeRealtimeLifecycle(event, signal) : event;
}
