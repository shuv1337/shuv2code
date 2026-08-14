/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  VoiceRuntimeInstanceId,
  ProviderDriverKind,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type TurnId,
} from "@shuv2code/contracts";
import { causeErrorTag } from "@shuv2code/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { sanitizeProviderObservabilityEvent } from "../RealtimeObservability.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    runtimeInstanceId: session.runtimeInstanceId ?? null,
    providerSessionId: session.providerSessionId ?? null,
    providerThreadId: session.providerThreadId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedActiveTurnId(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): TurnId | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const activeTurnId = "activeTurnId" in runtimePayload ? runtimePayload.activeTurnId : undefined;
  return typeof activeTurnId === "string" && activeTurnId.trim().length > 0
    ? (activeTurnId as TurnId)
    : undefined;
}

function explicitTerminalTurnStatus(
  snapshot: ProviderThreadSnapshot,
  turnId: TurnId,
): "completed" | "failed" | "interrupted" | undefined {
  const status = snapshot.turns.find((turn) => turn.id === turnId)?.status;
  return status === "completed" || status === "failed" || status === "interrupted"
    ? status
    : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const idleTurnLanes = new Map<
    ThreadId,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const withIdleTurnLane = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) => {
    const existing = idleTurnLanes.get(threadId);
    const lane = existing ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    if (!existing) idleTurnLanes.set(threadId, lane);
    lane.users += 1;
    return lane.semaphore
      .withPermits(1)(effect)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lane.users -= 1;
            if (lane.users === 0 && idleTurnLanes.get(threadId) === lane) {
              idleTurnLanes.delete(threadId);
            }
          }),
        ),
      );
  };
  // Managed voice thread ids are server-generated and never recycled as
  // ordinary provider sessions. Keep this set monotonic so late runtime events
  // emitted after stop/crash remain subject to the voice observability policy.
  const sensitiveRuntimeThreadIds = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const prepareFreshMcpSessions = Effect.fn("prepareFreshMcpSessions")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly controllerGrant?: ProviderSessionStartInput["controllerGrant"];
  }) {
    yield* clearMcpSession(input.threadId);
    const standard = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
    });
    if (standard) {
      McpProviderSession.setMcpProviderSession(standard.config);
    }
    if (input.controllerGrant === undefined) {
      return undefined;
    }
    const controller = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      profile: {
        kind: "voice-controller",
        controllerThreadId: input.controllerGrant.controllerThreadId,
        runtimeInstanceId: VoiceRuntimeInstanceId.make(input.controllerGrant.runtimeInstanceId),
        authorizedRuntimeCeiling: input.controllerGrant.authorizedRuntimeCeiling,
        liveControllerRuntimeMode: input.controllerGrant.liveControllerRuntimeMode,
        controlEpoch: input.controllerGrant.controlEpoch,
        controlEnabled: input.controllerGrant.controlEnabled,
      },
    });
    if (controller) {
      McpProviderSession.setMcpProviderSession(controller.config);
    }
    return controller;
  });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (canonicalEventLogger) {
        const sensitiveRuntime = (yield* Ref.get(sensitiveRuntimeThreadIds)).has(event.threadId);
        const safeEvent = sanitizeProviderObservabilityEvent("canonical", event, {
          sensitiveRuntime,
        });
        if (safeEvent !== undefined) {
          yield* canonicalEventLogger.write(safeEvent, event.threadId);
        }
      }
      yield* PubSub.publish(runtimeEventPubSub, event);
    }).pipe(Effect.asVoid);

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(
          Effect.andThen(publishRuntimeEvent(canonicalEvent)),
          // Keep the durable OpenCode/shuvcode resume cursor in sync when a
          // turn settles so a later restart does not re-open a finished turn.
          Effect.andThen(
            (canonicalEvent.type === "turn.completed" || canonicalEvent.type === "turn.aborted") &&
              canonicalEvent.threadId !== undefined
              ? Effect.gen(function* () {
                  const adapterOption = yield* registry
                    .getByInstance(source.instanceId)
                    .pipe(Effect.option);
                  if (Option.isNone(adapterOption)) {
                    return;
                  }
                  const sessions = yield* adapterOption.value.listSessions();
                  const session = sessions.find(
                    (entry) => entry.threadId === canonicalEvent.threadId,
                  );
                  if (!session || session.resumeCursor === undefined) {
                    return;
                  }
                  yield* upsertSessionBinding(
                    { ...session, providerInstanceId: source.instanceId },
                    canonicalEvent.threadId,
                    {
                      lastRuntimeEvent: `provider.${canonicalEvent.type}`,
                      lastRuntimeEventAt: canonicalEvent.createdAt,
                    },
                  ).pipe(Effect.ignore);
                })
              : Effect.void,
          ),
        ),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        const isVoiceController = input.threadPurpose === "voice-controller";
        const isVoiceTransport = input.threadPurpose === "voice-transport";
        const isManagedVoicePurpose = isVoiceController || isVoiceTransport;
        if (isManagedVoicePurpose && input.runtimeInstanceId === undefined) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Managed '${input.threadPurpose}' sessions require a trusted runtime instance id.`,
          );
        }
        if (!isManagedVoicePurpose && input.runtimeInstanceId !== undefined) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Runtime instance identity overrides are reserved for managed voice sessions.",
          );
        }
        if (isVoiceTransport && input.enableRealtimeConversation !== true) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Voice transport sessions require realtime conversation mode.",
          );
        }
        if (!isVoiceTransport && input.enableRealtimeConversation === true) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Realtime conversation mode is reserved for voice transport sessions.",
          );
        }
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in shuv2code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.recoveryPolicy === "forbid"
            ? undefined
            : (input.resumeCursor ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? persistedBinding.resumeCursor
                : undefined));
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        const controllerGrant =
          input.threadPurpose === "voice-controller" ? input.controllerGrant : undefined;
        if (input.threadPurpose === "voice-controller" && controllerGrant === undefined) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Voice controller sessions require a trusted controller grant.",
          );
        }
        if (
          controllerGrant !== undefined &&
          input.runtimeInstanceId !== controllerGrant.runtimeInstanceId
        ) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Voice controller runtime identity must match its controller grant.",
          );
        }
        const controllerCredential = yield* prepareFreshMcpSessions({
          threadId,
          providerInstanceId: resolvedInstanceId,
          ...(controllerGrant !== undefined ? { controllerGrant } : {}),
        });
        if (controllerGrant !== undefined && controllerCredential === undefined) {
          return yield* toValidationError(
            "ProviderService.startSession",
            "Controller MCP credential registry is unavailable.",
          );
        }
        if (isManagedVoicePurpose) {
          // Mark before starting the adapter so startup failures, immediately
          // emitted events, and late post-stop events are classified
          // conservatively.
          yield* Ref.update(sensitiveRuntimeThreadIds, (current) => {
            const next = new Set(current);
            next.add(threadId);
            return next;
          });
        }
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        if (controllerCredential !== undefined) {
          if (
            session.providerThreadId === undefined ||
            session.runtimeInstanceId !== controllerGrant?.runtimeInstanceId
          ) {
            yield* clearMcpSession(threadId);
            return yield* toValidationError(
              "ProviderService.startSession",
              "Controller provider identity was not returned by the started runtime.",
            );
          }
          const bound = yield* McpSessionRegistry.bindActiveControllerMcpProviderIdentity(
            controllerCredential.config.credentialId,
            { codexProviderThreadId: session.providerThreadId },
          );
          if (!bound) {
            yield* clearMcpSession(threadId);
            return yield* toValidationError(
              "ProviderService.startSession",
              "Controller MCP credential could not be bound to the provider thread.",
            );
          }
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const recoverCreatedSession: NonNullable<
    ProviderService.ProviderService["Service"]["recoverCreatedSession"]
  > = Effect.fn("ProviderService.recoverCreatedSession")(function* (input) {
    const resolvedInstanceId = yield* requireBindingInstanceId(
      "ProviderService.recoverCreatedSession",
      input,
    );
    const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
    if (!instanceInfo.enabled) {
      return yield* toValidationError(
        "ProviderService.recoverCreatedSession",
        `Provider instance '${resolvedInstanceId}' is disabled in shuv2code settings.`,
      );
    }
    const adapter = yield* registry.getByInstance(resolvedInstanceId);
    if (adapter.recoverSessionByThreadSource === undefined) {
      return yield* toValidationError(
        "ProviderService.recoverCreatedSession",
        `Provider '${adapter.provider}' does not support exact creation recovery.`,
      );
    }
    yield* prepareFreshMcpSessions({
      threadId: input.threadId,
      providerInstanceId: resolvedInstanceId,
    });
    const result = yield* adapter
      .recoverSessionByThreadSource({
        ...input,
        provider: adapter.provider,
        providerInstanceId: resolvedInstanceId,
      })
      .pipe(Effect.onError(() => clearMcpSession(input.threadId)));
    if (result.state !== "adopted") {
      yield* clearMcpSession(input.threadId);
      return result;
    }
    const session = {
      ...result.session,
      providerInstanceId: resolvedInstanceId,
    };
    if (session.provider !== adapter.provider || session.providerThreadId === undefined) {
      yield* clearMcpSession(input.threadId);
      return yield* toValidationError(
        "ProviderService.recoverCreatedSession",
        "Recovered provider identity did not match the intended session.",
      );
    }
    yield* stopStaleSessionsForThread({
      threadId: input.threadId,
      currentInstanceId: resolvedInstanceId,
    });
    yield* upsertSessionBinding(session, input.threadId, {
      modelSelection: input.modelSelection,
    });
    return { state: "adopted" as const, session };
  });

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    const send = Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: input.recoveryPolicy !== "forbid",
      });
      if (input.expectedTurnId === null) {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        let activeTurnId = binding ? readPersistedActiveTurnId(binding.runtimePayload) : undefined;
        if (binding !== undefined && activeTurnId !== undefined) {
          const persisted = yield* routed.adapter.readThread(routed.threadId).pipe(Effect.option);
          const terminalStatus = Option.isSome(persisted)
            ? explicitTerminalTurnStatus(persisted.value, activeTurnId)
            : undefined;
          if (terminalStatus !== undefined) {
            yield* directory.upsert({
              threadId: input.threadId,
              provider: binding.provider,
              providerInstanceId: routed.instanceId,
              status: terminalStatus === "failed" ? "error" : "running",
              runtimePayload: {
                activeTurnId: null,
                lastRuntimeEvent: `provider.history.${terminalStatus}`,
                lastRuntimeEventAt: yield* nowIso,
              },
            });
            activeTurnId = undefined;
          }
        }
        if (activeTurnId !== undefined) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            `stale_target: thread '${input.threadId}' already has active turn '${activeTurnId}'.`,
          );
        }
      }
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    });
    return yield* (
      input.expectedTurnId === null ? withIdleTurnLane(input.threadId, send) : send
    ).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const steerTurn: ProviderServiceMethod<"steerTurn"> = Effect.fn("steerTurn")(
    function* (rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.steerTurn",
        schema: ProviderSteerTurnInput,
        payload: rawInput,
      });
      const input = {
        ...parsed,
        attachments: parsed.attachments ?? [],
      };
      if (!input.input && input.attachments.length === 0) {
        return yield* toValidationError(
          "ProviderService.steerTurn",
          "Either input text or at least one attachment is required",
        );
      }
      let metricProvider = "unknown";
      let metricModel = input.modelSelection?.model;
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.steerTurn",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        if (!routed.isActive) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            `Cannot steer thread '${input.threadId}' because its provider session is not active.`,
          );
        }
        if (
          routed.adapter.capabilities.turnSteering !== "same-turn" ||
          routed.adapter.steerTurn === undefined
        ) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            `Provider '${routed.adapter.provider}' does not support same-turn steering.`,
          );
        }
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const activeTurnId = binding
          ? readPersistedActiveTurnId(binding.runtimePayload)
          : undefined;
        if (activeTurnId !== input.expectedTurnId) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            activeTurnId === undefined
              ? `already_terminal: thread '${input.threadId}' has no active turn.`
              : `stale_target: expected turn '${input.expectedTurnId}', current turn is '${activeTurnId}'.`,
          );
        }
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "steer-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.expectedTurnId,
          "provider.attachment_count": input.attachments.length,
        });
        yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
        const turn = yield* routed.adapter.steerTurn(input);
        if (turn.turnId !== input.expectedTurnId) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            `Provider acknowledged unexpected turn '${turn.turnId}' while steering '${input.expectedTurnId}'.`,
          );
        }
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.steerTurn",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
        yield* analytics.record("provider.turn.steered", {
          provider: routed.adapter.provider,
          model: input.modelSelection?.model,
          interactionMode: input.interactionMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          timer: providerTurnDuration,
          attributes: () =>
            providerTurnMetricAttributes({
              provider: metricProvider,
              model: metricModel,
              extra: {
                operation: "steer",
              },
            }),
        }),
      );
    },
  );

  const requireRealtimeAdapter = Effect.fn("requireRealtimeAdapter")(function* (
    threadId: ThreadId,
    operation: string,
  ) {
    const routed = yield* resolveRoutableSession({
      threadId,
      operation,
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        operation,
        `Cannot use realtime on thread '${threadId}' because its provider session is not active.`,
      );
    }
    return routed;
  });

  const startRealtime: ProviderServiceMethod<"startRealtime"> = Effect.fn("startRealtime")(
    function* (input) {
      const transportType = input.transportType ?? "webrtc";
      if (
        !Number.isSafeInteger(input.generation) ||
        input.generation < 1 ||
        input.realtimeSessionId.trim().length === 0 ||
        (transportType === "webrtc" && (input.offerSdp?.length ?? 0) === 0)
      ) {
        return yield* toValidationError(
          "ProviderService.startRealtime",
          "A positive generation, realtime session id, and matching transport payload are required.",
        );
      }
      const routed = yield* requireRealtimeAdapter(input.threadId, "ProviderService.startRealtime");
      if (routed.adapter.startRealtime === undefined) {
        return yield* toValidationError(
          "ProviderService.startRealtime",
          `Provider '${routed.adapter.provider}' does not support realtime transport.`,
        );
      }
      yield* routed.adapter.startRealtime(input);
    },
  );

  const appendRealtimeText: ProviderServiceMethod<"appendRealtimeText"> = Effect.fn(
    "appendRealtimeText",
  )(function* (input) {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.text.length === 0
    ) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeText",
        "A positive generation and non-empty text are required.",
      );
    }
    const routed = yield* requireRealtimeAdapter(
      input.threadId,
      "ProviderService.appendRealtimeText",
    );
    if (routed.adapter.appendRealtimeText === undefined) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeText",
        `Provider '${routed.adapter.provider}' does not support realtime text input.`,
      );
    }
    yield* routed.adapter.appendRealtimeText(input);
  });

  const appendRealtimeSpeech: ProviderServiceMethod<"appendRealtimeSpeech"> = Effect.fn(
    "appendRealtimeSpeech",
  )(function* (input) {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.text.length === 0
    ) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeSpeech",
        "A positive generation and non-empty text are required.",
      );
    }
    const routed = yield* requireRealtimeAdapter(
      input.threadId,
      "ProviderService.appendRealtimeSpeech",
    );
    if (routed.adapter.appendRealtimeSpeech === undefined) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeSpeech",
        `Provider '${routed.adapter.provider}' does not support realtime speech input.`,
      );
    }
    yield* routed.adapter.appendRealtimeSpeech(input);
  });

  const appendRealtimeAudio: ProviderServiceMethod<"appendRealtimeAudio"> = Effect.fn(
    "appendRealtimeAudio",
  )(function* (input) {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.audioBase64.length === 0
    ) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeAudio",
        "A positive generation and non-empty audio chunk are required.",
      );
    }
    const routed = yield* requireRealtimeAdapter(
      input.threadId,
      "ProviderService.appendRealtimeAudio",
    );
    if (routed.adapter.appendRealtimeAudio === undefined) {
      return yield* toValidationError(
        "ProviderService.appendRealtimeAudio",
        `Provider '${routed.adapter.provider}' does not support realtime audio input.`,
      );
    }
    yield* routed.adapter.appendRealtimeAudio(input);
  });

  const stopRealtime: ProviderServiceMethod<"stopRealtime"> = Effect.fn("stopRealtime")(
    function* (input) {
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
        return yield* toValidationError(
          "ProviderService.stopRealtime",
          "A positive generation is required.",
        );
      }
      const routed = yield* requireRealtimeAdapter(input.threadId, "ProviderService.stopRealtime");
      if (routed.adapter.stopRealtime === undefined) {
        return yield* toValidationError(
          "ProviderService.stopRealtime",
          `Provider '${routed.adapter.provider}' does not support realtime transport.`,
        );
      }
      yield* routed.adapter.stopRealtime(input);
    },
  );

  const listRealtimeVoices: ProviderServiceMethod<"listRealtimeVoices"> = Effect.fn(
    "listRealtimeVoices",
  )(function* (threadId) {
    const routed = yield* requireRealtimeAdapter(threadId, "ProviderService.listRealtimeVoices");
    if (routed.adapter.listRealtimeVoices === undefined) {
      return yield* toValidationError(
        "ProviderService.listRealtimeVoices",
        `Provider '${routed.adapter.provider}' does not expose a realtime voice catalog.`,
      );
    }
    return yield* routed.adapter.listRealtimeVoices(threadId);
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        if (!routed.isActive) {
          return yield* toValidationError(
            "ProviderService.interruptTurn",
            `Cannot interrupt thread '${input.threadId}' because its provider session is not active.`,
          );
        }
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const activeTurnId = binding
          ? readPersistedActiveTurnId(binding.runtimePayload)
          : undefined;
        if (activeTurnId !== input.turnId) {
          return yield* toValidationError(
            "ProviderService.interruptTurn",
            activeTurnId === undefined
              ? `already_terminal: thread '${input.threadId}' has no active turn.`
              : `stale_target: expected turn '${input.turnId}', current turn is '${activeTurnId}'.`,
          );
        }
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const prepareThreadHistory: NonNullable<ProviderServiceMethod<"prepareThreadHistory">> =
    Effect.fn("ProviderService.prepareThreadHistory")(function* (input) {
      const bindingOption = yield* directory.getBinding(input.threadId);
      if (Option.isNone(bindingOption)) {
        return {
          state: "ready" as const,
          historyMode: "not-applicable" as const,
        };
      }
      const binding = bindingOption.value;
      const instanceId = dieOnMissingBindingInstanceId(
        "ProviderService.prepareThreadHistory",
        binding,
      );
      const adapter = yield* registry.getByInstance(instanceId);
      if (adapter.provider !== ProviderDriverKind.make("codex")) {
        return { state: "ready" as const, historyMode: "not-applicable" as const };
      }
      if (adapter.prepareThreadHistory === undefined) {
        return {
          state: "unsupported" as const,
          message: "Update Codex before loading this legacy thread.",
        };
      }
      const cursor = binding.resumeCursor;
      const providerThreadId =
        typeof cursor === "object" &&
        cursor !== null &&
        !Array.isArray(cursor) &&
        typeof Reflect.get(cursor, "threadId") === "string"
          ? (Reflect.get(cursor, "threadId") as string)
          : undefined;
      if (providerThreadId === undefined) {
        return { state: "ready" as const, historyMode: "not-applicable" as const };
      }
      return yield* adapter.prepareThreadHistory({
        threadId: input.threadId,
        providerThreadId,
        action: input.action,
      });
    });

  const hasDurableSessionRecovery: ProviderServiceMethod<"hasDurableSessionRecovery"> = (
    threadId,
    instanceId,
  ) =>
    Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (Option.isNone(adapter)) {
        return false;
      }
      const binding = yield* directory.getBinding(threadId);
      if (Option.isNone(binding) || binding.value.providerInstanceId !== instanceId) {
        return false;
      }
      const check = adapter.value.capabilities.hasDurableSessionRecovery;
      return check === undefined ? false : yield* check(binding.value.resumeCursor);
    });

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const readThread: ProviderServiceMethod<"readThread"> = Effect.fn("ProviderService.readThread")(
    function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.readThread",
        allowRecovery: true,
      });
      return yield* routed.adapter.readThread(routed.threadId);
    },
  );

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        // OpenCode/shuvcode shared services detach on stopAll instead of
        // aborting. Keep their resume bindings alive so startup recovery can
        // reattach to durable in-flight work after a shuv2code restart.
        const durableResumeCheck = yield* registry.getByInstance(providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            adapter.capabilities.hasDurableSessionRecovery === undefined
              ? Effect.succeed(false)
              : adapter.capabilities.hasDurableSessionRecovery(binding.resumeCursor),
          ),
          Effect.orElseSucceed(() => false),
        );
        const durableResume =
          durableResumeCheck &&
          binding.resumeCursor !== null &&
          binding.resumeCursor !== undefined &&
          binding.status !== "stopped";
        if (durableResume) {
          return yield* directory.upsert({
            threadId: binding.threadId,
            provider: binding.provider,
            providerInstanceId,
            status: binding.status === "error" ? "error" : "running",
            resumeCursor: binding.resumeCursor,
            runtimePayload: {
              ...(binding.runtimePayload &&
              typeof binding.runtimePayload === "object" &&
              !Array.isArray(binding.runtimePayload)
                ? binding.runtimePayload
                : {}),
              lastRuntimeEvent: "provider.detachAll",
              lastRuntimeEventAt: yield* nowIso,
            },
          });
        }
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  // Proactively reattach OpenCode/shuvcode sessions that were left running
  // (or mid-turn) across a previous process lifetime. Lazy recovery on the
  // next sendTurn is not enough — an orphaned in-flight turn never receives
  // its completion events unless something reopens the event pump.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
      for (const binding of bindings) {
        const canRecover = yield* registry
          .getByInstance(dieOnMissingBindingInstanceId("ProviderService.startupRecover", binding))
          .pipe(
            Effect.flatMap((adapter) =>
              adapter.capabilities.hasDurableSessionRecovery === undefined
                ? Effect.succeed(false)
                : adapter.capabilities.hasDurableSessionRecovery(binding.resumeCursor),
            ),
            Effect.orElseSucceed(() => false),
          );
        if (!canRecover) {
          continue;
        }
        if (binding.status === "stopped") {
          continue;
        }
        if (binding.resumeCursor === null || binding.resumeCursor === undefined) {
          continue;
        }
        const resumeRecord =
          typeof binding.resumeCursor === "object" &&
          binding.resumeCursor !== null &&
          !Array.isArray(binding.resumeCursor)
            ? (binding.resumeCursor as Record<string, unknown>)
            : undefined;
        const hasInFlightTurn =
          typeof resumeRecord?.activeTurnId === "string" &&
          resumeRecord.activeTurnId.trim().length > 0;
        if (binding.status !== "running" && !hasInFlightTurn) {
          continue;
        }

        yield* recoverSessionForThread({
          binding,
          operation: "ProviderService.startupRecover",
        }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.startup-recovered", {
              threadId: binding.threadId,
              provider: binding.provider,
              hasInFlightTurn,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.startup-recover-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              cause,
            }),
          ),
        );
      }
    }),
  );

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    recoverCreatedSession,
    sendTurn,
    steerTurn,
    startRealtime,
    appendRealtimeText,
    appendRealtimeSpeech,
    appendRealtimeAudio,
    stopRealtime,
    listRealtimeVoices,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    hasDurableSessionRecovery,
    getInstanceInfo,
    readThread,
    prepareThreadHistory,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
