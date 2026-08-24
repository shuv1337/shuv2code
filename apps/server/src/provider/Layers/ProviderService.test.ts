// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@shuv2code/contracts";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import { createModelSelection } from "@shuv2code/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderCreationRecoveryInput,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import type { McpCredentialProfile } from "../../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const codexInstanceId = ProviderInstanceId.make("codex");
const openCodeV2InstanceId = ProviderInstanceId.make("opencodeV2");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const OPENCODE_V2_DRIVER = ProviderDriverKind.make("opencodeV2");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        ...(typeof input.resumeCursor === "object" &&
        input.resumeCursor !== null &&
        "threadId" in input.resumeCursor &&
        typeof input.resumeCursor.threadId === "string"
          ? { providerThreadId: input.resumeCursor.threadId }
          : {}),
        ...(input.runtimeInstanceId !== undefined
          ? { runtimeInstanceId: input.runtimeInstanceId }
          : {}),
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const recoverSessionByThreadSource = vi.fn((input: ProviderCreationRecoveryInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const providerThreadId = `recovered-${input.threadSource}`;
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        providerThreadId,
        ...(input.runtimeInstanceId !== undefined
          ? { runtimeInstanceId: input.runtimeInstanceId }
          : {}),
        resumeCursor: { threadId: providerThreadId },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return { state: "adopted" as const, session };
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const steerTurn = vi.fn((input: import("@shuv2code/contracts").ProviderSteerTurnInput) =>
    Effect.succeed({
      threadId: input.threadId,
      turnId: input.expectedTurnId,
    }),
  );

  const startRealtime = vi.fn(() => Effect.void);
  const appendRealtimeText = vi.fn(() => Effect.void);
  const appendRealtimeSpeech = vi.fn(() => Effect.void);
  const stopRealtime = vi.fn(() => Effect.void);
  const listRealtimeVoices = vi.fn(() =>
    Effect.succeed({
      voices: [{ id: "alloy" }],
      defaultVoiceId: "alloy",
    }),
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: readonly [];
          status?: "completed" | "interrupted" | "failed" | "inProgress";
        }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      turnSteering: "same-turn",
      hasDurableSessionRecovery: (resumeCursor) =>
        Effect.succeed(
          typeof resumeCursor === "object" &&
            resumeCursor !== null &&
            "durable" in resumeCursor &&
            resumeCursor.durable === true,
        ),
    },
    startSession,
    recoverSessionByThreadSource,
    sendTurn,
    steerTurn,
    startRealtime,
    appendRealtimeText,
    appendRealtimeSpeech,
    stopRealtime,
    listRealtimeVoices,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    recoverSessionByThreadSource,
    sendTurn,
    steerTurn,
    startRealtime,
    appendRealtimeText,
    appendRealtimeSpeech,
    stopRealtime,
    listRealtimeVoices,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const openCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("opencodeV2")]: openCodeV2.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    openCodeV2,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const openCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [OPENCODE_V2_DRIVER]: openCodeV2.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === openCodeV2InstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: OPENCODE_V2_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: OPENCODE_V2_DRIVER,
                continuationKey: "opencodeV2:instance:opencodeV2",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("opencodeV2"),
          providerInstanceId: openCodeV2InstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'opencodeV2' is disabled");
    assert.equal(openCodeV2.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive classifies realtime payloads before the canonical logger", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: Array<unknown> = [];
    const secret = "VOICE_SECRET_SHOULD_NEVER_REACH_CANONICAL_LOGGER";
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-sensitive-events",
        write: (event) =>
          Effect.sync(() => {
            canonicalEvents.push(event);
          }),
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      const eventBase = {
        eventId: asEventId("evt-canonical-realtime"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-realtime"),
        createdAt: "2026-01-01T00:00:00.000Z",
      } as const;

      for (const [index, type] of [
        "thread.realtime.item-added",
        "thread.realtime.transcript.delta",
        "thread.realtime.transcript.done",
        "thread.realtime.audio.delta",
        "thread.realtime.sdp",
      ].entries()) {
        codex.emit({
          ...eventBase,
          eventId: asEventId(`evt-canonical-sensitive-${index}`),
          type,
          payload: { text: secret, item: secret, audio: secret, sdp: secret },
          raw: { payload: secret },
        });
      }
      codex.emit({
        ...eventBase,
        eventId: asEventId("evt-canonical-started"),
        type: "thread.realtime.started",
        payload: {
          version: "v3",
          realtimeSessionId: secret,
          transcript: secret,
        },
        raw: { payload: secret },
      });
      codex.emit({
        ...eventBase,
        eventId: asEventId("evt-canonical-error"),
        type: "thread.realtime.error",
        payload: {
          code: "protocol_violation",
          message: secret,
          retryable: true,
        },
        raw: { payload: secret },
      });
      codex.emit({
        ...eventBase,
        eventId: asEventId("evt-canonical-closed"),
        type: "thread.realtime.closed",
        payload: { reason: secret },
        raw: { payload: secret },
      });
      yield* advanceTestClock(50);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 3);
    assert.deepEqual(
      canonicalEvents.map((event) => Reflect.get(event as object, "type")),
      ["thread.realtime.started", "thread.realtime.error", "thread.realtime.closed"],
    );
    const serialized = yield* encodeUnknownJson(canonicalEvents);
    assert.notInclude(serialized, secret);
    assert.notInclude(serialized, '"raw"');
    assert.include(serialized, '"version":"v3"');
    assert.include(serialized, '"code":"protocol_violation"');
    assert.include(serialized, '"reasonCode":"unknown"');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive never writes raw native-derived events for managed voice threads",
  () =>
    Effect.gen(function* () {
      const codex = makeFakeCodexAdapter();
      const canonicalEvents: Array<unknown> = [];
      const secret = "VOICE_CONTROLLER_NATIVE_EVENT_SECRET";
      const voiceThreadId = asThreadId("voice-transport:canonical-log-test");
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codex.adapter,
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive({
        canonicalEventLogger: {
          filePath: "memory://provider-canonical-voice-runtime-events",
          write: (event) =>
            Effect.sync(() => {
              canonicalEvents.push(event);
            }),
          close: () => Effect.void,
        },
      }).pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(voiceThreadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId: voiceThreadId,
          threadPurpose: "voice-transport",
          runtimeInstanceId: "voice-runtime-log-test",
          enableRealtimeConversation: true,
          runtimeMode: "approval-required",
        });
        yield* advanceTestClock(10);

        const eventBase = {
          provider: ProviderDriverKind.make("codex"),
          threadId: voiceThreadId,
          createdAt: "2026-01-01T00:00:00.000Z",
        } as const;
        codex.emit({
          ...eventBase,
          eventId: asEventId("evt-voice-item"),
          type: "item.completed",
          payload: {
            itemType: "mcp_tool_call",
            arguments: { authorization: secret },
            result: { content: secret },
            transcript: secret,
          },
          raw: {
            source: "codex.app-server.notification",
            method: "item/completed",
            payload: { sdp: secret, audio: secret },
          },
        });
        codex.emit({
          ...eventBase,
          eventId: asEventId("evt-voice-runtime-error"),
          type: "runtime.error",
          payload: {
            message: secret,
            class: "provider_error",
            detail: { cause: secret },
            runtimeInstanceId: "voice-runtime-log-test",
          },
          raw: {
            source: "codex.app-server.notification",
            method: "error",
            payload: { error: secret },
          },
        });
        yield* provider.stopSession({ threadId: voiceThreadId });
        codex.emit({
          ...eventBase,
          eventId: asEventId("evt-voice-late-exit"),
          type: "session.exited",
          payload: {
            state: "stopped",
            reason: secret,
            runtimeInstanceId: "voice-runtime-log-test",
          },
          raw: {
            source: "codex.app-server.notification",
            method: "session/closed",
            payload: { transcript: secret },
          },
        });
        yield* advanceTestClock(50);
      }).pipe(Effect.provide(providerLayer));

      assert.equal(canonicalEvents.length, 2);
      assert.deepEqual(
        canonicalEvents.map((event) => Reflect.get(event as object, "type")),
        ["runtime.error", "session.exited"],
      );
      const serialized = yield* encodeUnknownJson(canonicalEvents);
      assert.notInclude(serialized, secret);
      assert.notInclude(serialized, '"raw"');
      assert.notInclude(serialized, '"payload"');
      assert.include(serialized, '"code":"internal_error"');
      assert.include(serialized, '"state":"stopped"');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "shuv2code-provider-service-"),
    );
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "shuv2code-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("reconciles an exact terminal turn before an idle-only send", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-terminal-history");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const first = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
        expectedTurnId: null,
      });
      routing.codex.readThread.mockImplementationOnce(() =>
        Effect.succeed({
          threadId,
          turns: [{ id: first.turnId, items: [], status: "completed" }],
        }),
      );

      const second = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
        expectedTurnId: null,
      });

      assert.equal(second.turnId, first.turnId);
      assert.equal(routing.codex.readThread.mock.calls.length, 1);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.readThread.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("preserves a legacy start that omits the idle-turn precondition", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-legacy-concurrent-start");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const first = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
        expectedTurnId: null,
      });
      routing.codex.readThread.mockImplementationOnce(() =>
        Effect.succeed({
          threadId,
          turns: [{ id: first.turnId, items: [], status: "inProgress" }],
        }),
      );

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "legacy duplicate",
        attachments: [],
      });

      assert.equal(routing.codex.readThread.mock.calls.length, 0);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.readThread.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("serializes concurrent explicit idle-only starts on the same thread", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-concurrent-idle-start");
      const firstEnteredAdapter = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(firstEnteredAdapter, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as({ threadId: input.threadId, turnId: asTurnId("turn-concurrent-winner") }),
        ),
      );

      const first = yield* provider
        .sendTurn({ threadId, input: "first", attachments: [], expectedTurnId: null })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEnteredAdapter);
      const second = yield* provider
        .sendTurn({ threadId, input: "second", attachments: [], expectedTurnId: null })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      const failure = yield* Fiber.join(second).pipe(Effect.flip);

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "already has active turn 'turn-concurrent-winner'");
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();
      routing.codex.readThread.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("keeps explicit idle-only starts on different threads independent", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const blockedThreadId = asThreadId("thread-idle-blocked");
      const independentThreadId = asThreadId("thread-idle-independent");
      const blockedEnteredAdapter = yield* Deferred.make<void>();
      const releaseBlocked = yield* Deferred.make<void>();
      for (const threadId of [blockedThreadId, independentThreadId]) {
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }
      routing.codex.sendTurn.mockImplementation((input) =>
        input.threadId === blockedThreadId
          ? Deferred.succeed(blockedEnteredAdapter, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBlocked)),
              Effect.as({ threadId: input.threadId, turnId: asTurnId("turn-blocked") }),
            )
          : Effect.succeed({
              threadId: input.threadId,
              turnId: asTurnId("turn-independent"),
            }),
      );

      const blocked = yield* provider
        .sendTurn({
          threadId: blockedThreadId,
          input: "blocked",
          attachments: [],
          expectedTurnId: null,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(blockedEnteredAdapter);
      const independent = yield* provider.sendTurn({
        threadId: independentThreadId,
        input: "independent",
        attachments: [],
        expectedTurnId: null,
      });

      assert.equal(independent.turnId, "turn-independent");
      assert.equal(routing.codex.sendTurn.mock.calls.length, 2);
      yield* Deferred.succeed(releaseBlocked, undefined);
      yield* Fiber.join(blocked);
      for (const threadId of [blockedThreadId, independentThreadId]) {
        yield* provider.stopSession({ threadId });
      }
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockReset();
      routing.codex.sendTurn.mockImplementation((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: TurnId.make(`turn-${String(input.threadId)}`),
        }),
      );
      routing.codex.readThread.mockClear();
      routing.codex.stopSession.mockClear();
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.startRealtime({
        threadId: session.threadId,
        generation: 1,
        realtimeSessionId: "realtime-session-1",
        offerSdp: "v=0",
        clientManagedHandoffs: true,
      });
      yield* provider.appendRealtimeText({
        threadId: session.threadId,
        generation: 1,
        text: "hello transport",
        role: "user",
      });
      yield* provider.appendRealtimeSpeech({
        threadId: session.threadId,
        generation: 1,
        text: "hello voice",
      });
      const voices = yield* provider.listRealtimeVoices(session.threadId);
      assert.deepEqual(voices, {
        voices: [{ id: "alloy" }],
        defaultVoiceId: "alloy",
      });
      yield* provider.stopRealtime({ threadId: session.threadId, generation: 1 });
      assert.equal(routing.codex.startRealtime.mock.calls.length, 1);
      assert.equal(routing.codex.appendRealtimeText.mock.calls.length, 1);
      assert.equal(routing.codex.appendRealtimeSpeech.mock.calls.length, 1);
      assert.equal(routing.codex.stopRealtime.mock.calls.length, 1);

      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      const steered = yield* provider.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "focus on tests",
        clientUserMessageId: MessageId.make("message-steer"),
      });
      assert.equal(steered.turnId, turn.turnId);
      assert.deepEqual(routing.codex.steerTurn.mock.calls[0]?.[0], {
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "focus on tests",
        attachments: [],
        clientUserMessageId: MessageId.make("message-steer"),
      });

      yield* provider.interruptTurn({ threadId: session.threadId, turnId: turn.turnId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, turn.turnId]]);

      const providerSnapshot = yield* provider.readThread!(session.threadId);
      assert.deepEqual(providerSnapshot, {
        threadId: session.threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      });
      assert.deepEqual(routing.codex.readThread.mock.calls, [[session.threadId]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("resolves durable recovery from the persisted instance binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const durableThreadId = asThreadId("thread-durable-recovery");

      yield* directory.upsert({
        threadId: durableThreadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        resumeCursor: { durable: true },
      });

      assert.equal(
        yield* provider.hasDurableSessionRecovery(durableThreadId, codexInstanceId),
        true,
      );
      assert.equal(
        yield* provider.hasDurableSessionRecovery(
          asThreadId("thread-missing-binding"),
          codexInstanceId,
        ),
        false,
      );
      assert.equal(
        yield* provider.hasDurableSessionRecovery(durableThreadId, openCodeV2InstanceId),
        false,
      );
      assert.equal(
        yield* provider.hasDurableSessionRecovery(
          durableThreadId,
          ProviderInstanceId.make("removed-instance"),
        ),
        false,
      );
    }),
  );
  it.effect("appends attachment file paths to the turn input text", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-attach"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-attach"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const attachment = {
        type: "image" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 123,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "use this screenshot",
        attachments: [attachment],
      });

      const turnInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(typeof turnInput.input, "string");
      const turnText = turnInput.input ?? "";
      assert.equal(turnText.startsWith("use this screenshot"), true);
      assert.include(turnText, '[Attached image "screenshot.png" is saved at: ');
      assert.equal(turnText.endsWith(`${attachment.id}.png]`), true);

      // An attachment-only turn stays valid and the injected line becomes the
      // whole input text, so the agent still learns the path.
      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        attachments: [attachment],
      });
      const imageOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(imageOnlyInput.input?.startsWith('[Attached image "screenshot.png"'), true);

      yield* provider.stopSession({ threadId: session.threadId });
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit opencodeV2 provider session starts to the opencodeV2 adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-opencode-v2"), {
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId: openCodeV2InstanceId,
        threadId: asThreadId("thread-opencode-v2"),
        cwd: "/tmp/project-opencode-v2",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "opencodeV2");
      assert.equal(routing.openCodeV2.startSession.mock.calls.length, 1);
      const startInput = routing.openCodeV2.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "opencodeV2");
        assert.equal(startPayload.providerInstanceId, openCodeV2InstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-opencode-v2");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId: openCodeV2InstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.openCodeV2.stopSession.mockClear();

      const openCodeV2Session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId: openCodeV2InstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(openCodeV2Session.provider, "opencodeV2");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.openCodeV2.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["opencodeV2"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("does not recover a missing runtime for steer", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-no-steer-recovery");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId,
        input: "start",
      });
      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.steerTurn.mockClear();

      const exit = yield* Effect.exit(
        provider.steerTurn({
          threadId,
          expectedTurnId: turn.turnId,
          input: "steer",
          clientUserMessageId: MessageId.make("message-no-recovery"),
        }),
      );

      assert.equal(exit._tag, "Failure");
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.steerTurn.mock.calls.length, 0);
    }),
  );

  it.effect("recovers stale opencodeV2 sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-opencode-v2-send-turn"), {
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId: openCodeV2InstanceId,
        threadId: asThreadId("thread-opencode-v2-send-turn"),
        cwd: "/tmp/project-opencode-v2-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencodeV2"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.openCodeV2.stopAll();
      routing.openCodeV2.startSession.mockClear();
      routing.openCodeV2.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with opencodeV2",
        attachments: [],
      });

      assert.equal(routing.openCodeV2.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.openCodeV2.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "opencodeV2");
        assert.equal(startPayload.cwd, "/tmp/project-opencode-v2-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("opencodeV2"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.openCodeV2.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.openCodeV2.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("persists the exact resume cursor adopted by creation recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-creation-recovery");
      const recovered = yield* provider.recoverCreatedSession!({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-creation-recovery",
        runtimeMode: "full-access",
        threadSource: "shuv2code_voice_controller_v11",
      });

      assert.equal(recovered.state, "adopted");
      if (recovered.state !== "adopted") {
        return assert.fail("expected the unique provider thread to be adopted");
      }
      const persisted = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.deepEqual(persisted.value.resumeCursor, recovered.session.resumeCursor);
        assert.deepEqual(persisted.value.resumeCursor, {
          threadId: "recovered-shuv2code_voice_controller_v11",
        });
      }
    }),
  );

  it.effect("prefers the persisted cursor and preserves the controller credential", () => {
    const credentialRequests: Array<McpSessionRegistry.McpCredentialRequest> = [];
    const identityBindings: Array<{
      readonly credentialId: string;
      readonly codexProviderThreadId: string;
    }> = [];
    const issueCredential = vi
      .spyOn(McpSessionRegistry, "issueActiveMcpCredential")
      .mockImplementation((request) =>
        Effect.sync(() => {
          credentialRequests.push(request);
          const environmentId = "environment-provider-recovery" as never;
          const requestedProfile = request.profile ?? ({ kind: "standard-provider" } as const);
          const profile: McpCredentialProfile =
            requestedProfile.kind === "voice-controller"
              ? {
                  ...requestedProfile,
                  providerIdentity: undefined,
                  scope: {
                    kind: "managed-codex-environment",
                    environmentId,
                  },
                }
              : requestedProfile.kind === "durable-thread-controller"
                ? { ...requestedProfile, providerIdentity: undefined }
                : requestedProfile;
          return {
            config: {
              credentialId: `credential-${profile.kind}`,
              environmentId,
              threadId: request.threadId,
              providerSessionId: `pending-${profile.kind}`,
              providerInstanceId: request.providerInstanceId,
              profile,
              endpoint:
                profile.kind === "voice-controller"
                  ? "http://127.0.0.1/mcp/controller"
                  : "http://127.0.0.1/mcp",
              authorizationHeader: `Bearer token-${profile.kind}`,
            },
          };
        }),
      );
    const bindIdentity = vi
      .spyOn(McpSessionRegistry, "bindActiveControllerMcpProviderIdentity")
      .mockImplementation((credentialId, identity) =>
        Effect.sync(() => {
          identityBindings.push({
            credentialId,
            codexProviderThreadId: identity.codexProviderThreadId,
          });
          return true;
        }),
      );

    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = asThreadId("controller-creation-recovery");
      const runtimeInstanceId = VoiceRuntimeInstanceId.make("controller-runtime-recovery");
      const persistedProviderThreadId = "persisted-controller-provider-thread";
      yield* runtimeRepository.upsert({
        threadId,
        providerName: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        adapterKey: CODEX_DRIVER,
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        resumeCursor: { threadId: persistedProviderThreadId },
        runtimePayload: null,
      });
      routing.codex.startSession.mockClear();
      routing.codex.recoverSessionByThreadSource.mockClear();
      const recovered = yield* provider.recoverCreatedSession!({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/controller-creation-recovery",
        runtimeMode: "full-access",
        threadSource: "shuv2code/voice-controller/controller-creation-recovery/v2",
        threadPurpose: "voice-controller",
        runtimeInstanceId,
        controllerGrant: {
          controllerThreadId: threadId,
          runtimeInstanceId,
          authorizedRuntimeCeiling: "full-access",
          liveControllerRuntimeMode: "full-access",
          controlEpoch: 7,
          controlEnabled: true,
        },
      });

      assert.equal(recovered.state, "adopted");
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(routing.codex.recoverSessionByThreadSource.mock.calls.length, 0);
      assert.deepEqual(routing.codex.startSession.mock.calls[0]?.[0].resumeCursor, {
        threadId: persistedProviderThreadId,
      });
      assert.equal(routing.codex.startSession.mock.calls[0]?.[0].threadSource, undefined);
      assert.deepEqual(
        credentialRequests.map((request) => request.profile?.kind ?? "standard-provider"),
        ["standard-provider", "voice-controller"],
      );
      assert.deepEqual(identityBindings, [
        {
          credentialId: "credential-voice-controller",
          codexProviderThreadId: persistedProviderThreadId,
        },
      ]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          issueCredential.mockRestore();
          bindIdentity.mockRestore();
          McpProviderSession.clearAllMcpProviderSessions();
        }),
      ),
    );
  });

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "shuv2code-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstOpenCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("opencodeV2")]: firstOpenCodeV2.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-opencode-v2-start"), {
          provider: ProviderDriverKind.make("opencodeV2"),
          providerInstanceId: openCodeV2InstanceId,
          threadId: asThreadId("thread-opencode-v2-start"),
          cwd: "/tmp/project-opencode-v2-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondOpenCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("opencodeV2")]: secondOpenCodeV2.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondOpenCodeV2.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("opencodeV2"),
          providerInstanceId: openCodeV2InstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-opencode-v2-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondOpenCodeV2.startSession.mock.calls.length, 1);
      const resumedStartInput = secondOpenCodeV2.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "opencodeV2");
        assert.equal(startPayload.cwd, "/tmp/project-opencode-v2-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes an opencodeV2 session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "shuv2code-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstOpenCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("opencodeV2")]: firstOpenCodeV2.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-opencode-v2-cwd"), {
            provider: ProviderDriverKind.make("opencodeV2"),
            providerInstanceId: openCodeV2InstanceId,
            threadId: asThreadId("thread-opencode-v2-cwd"),
            cwd: "/tmp/project-opencode-v2-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondOpenCodeV2 = makeFakeCodexAdapter(OPENCODE_V2_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("opencodeV2")]: secondOpenCodeV2.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondOpenCodeV2.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("opencodeV2"),
            providerInstanceId: openCodeV2InstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondOpenCodeV2.startSession.mock.calls.length, 1);
        const resumedStartInput = secondOpenCodeV2.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "opencodeV2");
          assert.equal(startPayload.cwd, "/tmp/project-opencode-v2-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId: openCodeV2InstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "metrics",
      });
      yield* provider.interruptTurn({ threadId: session.threadId, turnId: turn.turnId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "shuv2code_provider_turns_total", {
          provider: ProviderDriverKind.make("opencodeV2"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "shuv2code_provider_turns_total", {
          provider: ProviderDriverKind.make("opencodeV2"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "shuv2code_provider_turns_total", {
          provider: ProviderDriverKind.make("opencodeV2"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "shuv2code_provider_turns_total", {
          provider: ProviderDriverKind.make("opencodeV2"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "shuv2code_provider_sessions_total", {
          provider: ProviderDriverKind.make("opencodeV2"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("opencodeV2"),
          providerInstanceId: openCodeV2InstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "shuv2code_provider_turns_total", {
            provider: ProviderDriverKind.make("opencodeV2"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "shuv2code_provider_turn_duration", {
            provider: ProviderDriverKind.make("opencodeV2"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect(
    "issues and provider-binds a durable controller credential only for an explicit grant",
    () => {
      const requests: Array<McpSessionRegistry.McpCredentialRequest> = [];
      const bound: Array<{ readonly credentialId: string; readonly providerThreadId: string }> = [];
      const issue = vi
        .spyOn(McpSessionRegistry, "issueActiveMcpCredential")
        .mockImplementation((request) =>
          Effect.sync(() => {
            requests.push(request);
            const profile =
              request.profile?.kind === "durable-thread-controller"
                ? {
                    ...request.profile,
                    providerIdentity: undefined,
                  }
                : ({ kind: "standard-provider" } as const);
            return {
              config: {
                credentialId: `credential-${profile.kind}`,
                environmentId: "environment-durable-controller" as never,
                threadId: request.threadId,
                providerSessionId: `mcp-${profile.kind}`,
                providerInstanceId: request.providerInstanceId,
                profile,
                endpoint:
                  profile.kind === "durable-thread-controller"
                    ? "http://127.0.0.1/mcp/controller"
                    : "http://127.0.0.1/mcp",
                authorizationHeader: `Bearer token-${profile.kind}`,
              },
            };
          }),
        );
      const bind = vi
        .spyOn(McpSessionRegistry, "bindActiveControllerMcpProviderIdentity")
        .mockImplementation((credentialId, identity) =>
          Effect.sync(() => {
            bound.push({
              credentialId,
              providerThreadId: identity.codexProviderThreadId,
            });
            return true;
          }),
        );

      return Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("durable-controller-start");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          resumeCursor: { threadId: "provider-durable-controller" },
          runtimeMode: "auto-accept-edits",
          threadControlGrant: {
            controllerThreadId: threadId,
            authorizedRuntimeCeiling: "auto-accept-edits",
            controlEnabled: true,
          },
        });

        assert.deepEqual(
          requests.map((request) => request.profile?.kind ?? "standard-provider"),
          ["standard-provider", "durable-thread-controller"],
        );
        assert.deepEqual(bound, [
          {
            credentialId: "credential-durable-thread-controller",
            providerThreadId: "provider-durable-controller",
          },
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            issue.mockRestore();
            bind.mockRestore();
            McpProviderSession.clearAllMcpProviderSessions();
          }),
        ),
      );
    },
  );

  it.effect("restores and provider-binds a durable controller credential during recovery", () => {
    const requests: McpSessionRegistry.McpCredentialRequest[] = [];
    const bound: Array<{ readonly credentialId: string; readonly providerThreadId: string }> = [];
    const issue = vi
      .spyOn(McpSessionRegistry, "issueActiveMcpCredential")
      .mockImplementation((request) =>
        Effect.sync(() => {
          requests.push(request);
          const profile =
            request.profile?.kind === "durable-thread-controller"
              ? { ...request.profile, providerIdentity: undefined }
              : ({ kind: "standard-provider" } as const);
          return {
            config: {
              credentialId: `credential-${profile.kind}`,
              environmentId: "environment-durable-controller-recovery" as never,
              threadId: request.threadId,
              providerSessionId: `mcp-${profile.kind}`,
              providerInstanceId: request.providerInstanceId,
              profile,
              endpoint:
                profile.kind === "durable-thread-controller"
                  ? "http://127.0.0.1/mcp/controller"
                  : "http://127.0.0.1/mcp",
              authorizationHeader: `Bearer token-${profile.kind}`,
            },
          };
        }),
      );
    const bind = vi
      .spyOn(McpSessionRegistry, "bindActiveControllerMcpProviderIdentity")
      .mockImplementation((credentialId, identity) =>
        Effect.sync(() => {
          bound.push({
            credentialId,
            providerThreadId: identity.codexProviderThreadId,
          });
          return true;
        }),
      );

    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("durable-controller-recovery");
      const recovered = yield* provider.recoverCreatedSession!({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/durable-controller-recovery",
        runtimeMode: "auto-accept-edits",
        threadSource: "durable-controller-recovery-source",
        threadControlGrant: {
          controllerThreadId: threadId,
          authorizedRuntimeCeiling: "auto-accept-edits",
          controlEnabled: true,
        },
      });

      assert.equal(recovered.state, "adopted");
      assert.deepEqual(
        requests.map((request) => request.profile?.kind ?? "standard-provider"),
        ["standard-provider", "durable-thread-controller"],
      );
      assert.deepEqual(bound, [
        {
          credentialId: "credential-durable-thread-controller",
          providerThreadId: "recovered-durable-controller-recovery-source",
        },
      ]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          issue.mockRestore();
          bind.mockRestore();
          McpProviderSession.clearAllMcpProviderSessions();
        }),
      ),
    );
  });

  it.effect("reserves trusted runtime identity and realtime mode for managed voice purposes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      validation.codex.startSession.mockClear();
      const base = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "approval-required" as const,
      };
      const reject = (threadId: string, input: Record<string, unknown>, issue: string) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            provider.startSession(asThreadId(threadId), {
              ...base,
              threadId: asThreadId(threadId),
              ...input,
            }),
          );
          assert.instanceOf(failure, ProviderValidationError);
          assert.include(failure.issue, issue);
        });

      yield* reject(
        "standard-runtime-override",
        { runtimeInstanceId: "runtime-standard" },
        "reserved for managed voice sessions",
      );
      yield* reject(
        "standard-realtime",
        { enableRealtimeConversation: true },
        "reserved for voice transport sessions",
      );
      yield* reject(
        "controller-missing-runtime",
        { threadPurpose: "voice-controller" },
        "require a trusted runtime instance id",
      );
      yield* reject(
        "controller-realtime",
        {
          threadPurpose: "voice-controller",
          runtimeInstanceId: "runtime-controller",
          enableRealtimeConversation: true,
        },
        "reserved for voice transport sessions",
      );
      yield* reject(
        "transport-missing-runtime",
        { threadPurpose: "voice-transport", enableRealtimeConversation: true },
        "require a trusted runtime instance id",
      );
      yield* reject(
        "transport-missing-realtime",
        { threadPurpose: "voice-transport", runtimeInstanceId: "runtime-transport" },
        "require realtime conversation mode",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.openCodeV2.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: openCodeV2InstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'opencodeV2' belongs to driver 'opencodeV2', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.openCodeV2.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

it.effect("ProviderServiceLive re-adopts a migrated OpenCode V2 session after a cold restart", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "shuv2code-provider-service-opencode-v2-restart-"),
    );
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const opencodeV2Driver = ProviderDriverKind.make("opencodeV2");
    const opencodeV2InstanceId = ProviderInstanceId.make("opencodeV2");
    const legacyInstanceId = ProviderInstanceId.make("opencode");
    const threadId = asThreadId("thread-opencode-v2-cold-restart");
    const convertedResumeCursor = {
      kind: "opencode-v2",
      schemaVersion: 1,
      sessionId: "ses_opencode_v2_restart",
      activeTurnId: "turn_opencode_v2_restart",
    };

    const makeDurableOpenCodeV2 = (recovered?: Deferred.Deferred<void>) => {
      const fake = makeFakeCodexAdapter(opencodeV2Driver);
      const startSession = fake.adapter.startSession;
      return {
        ...fake,
        adapter: {
          ...fake.adapter,
          startSession: (input) =>
            startSession(input).pipe(
              Effect.tap(() => (recovered ? Deferred.succeed(recovered, undefined) : Effect.void)),
            ),
          capabilities: {
            ...fake.adapter.capabilities,
            hasDurableSessionRecovery: (resumeCursor: unknown) =>
              Effect.succeed(
                typeof resumeCursor === "object" &&
                  resumeCursor !== null &&
                  "kind" in resumeCursor &&
                  resumeCursor.kind === "opencode-v2",
              ),
          },
        } satisfies ProviderAdapterShape<ProviderAdapterError>,
      };
    };
    const makeServiceLayer = (fake: ReturnType<typeof makeDurableOpenCodeV2>) =>
      makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistry,
            makeAdapterRegistryMock({ [opencodeV2Driver]: fake.adapter }),
          ),
        ),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
    const firstOpenCodeV2 = makeDurableOpenCodeV2();
    const firstScope = yield* Scope.make();
    yield* Layer.build(makeServiceLayer(firstOpenCodeV2)).pipe(Scope.provide(firstScope));

    yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      yield* repository.upsert({
        threadId,
        providerName: "opencode",
        providerInstanceId: legacyInstanceId,
        adapterKey: "opencode",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-08-14T00:00:00.000Z",
        resumeCursor: {
          sessionId: convertedResumeCursor.sessionId,
          activeTurnId: convertedResumeCursor.activeTurnId,
        },
        runtimePayload: { cwd: "/tmp/project-opencode-v2-restart" },
      });
      yield* repository.remapOpenCodeV2Identity({
        fromInstanceId: legacyInstanceId,
        toInstanceId: opencodeV2InstanceId,
        toProviderName: opencodeV2Driver,
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));

    yield* Scope.close(firstScope, Exit.void);
    assert.equal(firstOpenCodeV2.startSession.mock.calls.length, 0);

    const persistedAfterShutdown = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(persistedAfterShutdown), true);
    if (Option.isSome(persistedAfterShutdown)) {
      assert.equal(persistedAfterShutdown.value.providerName, opencodeV2Driver);
      assert.equal(persistedAfterShutdown.value.providerInstanceId, opencodeV2InstanceId);
      assert.equal(persistedAfterShutdown.value.status, "running");
      assert.deepEqual(persistedAfterShutdown.value.resumeCursor, convertedResumeCursor);
    }

    const startupRecovered = yield* Deferred.make<void>();
    const secondOpenCodeV2 = makeDurableOpenCodeV2(startupRecovered);
    const secondScope = yield* Scope.make();
    yield* Layer.build(makeServiceLayer(secondOpenCodeV2)).pipe(Scope.provide(secondScope));
    yield* Deferred.await(startupRecovered);

    assert.equal(secondOpenCodeV2.startSession.mock.calls.length, 1);
    const recoveredInput = secondOpenCodeV2.startSession.mock.calls[0]?.[0];
    assert.equal(recoveredInput?.provider, opencodeV2Driver);
    assert.equal(recoveredInput?.providerInstanceId, opencodeV2InstanceId);
    assert.equal(recoveredInput?.threadId, threadId);
    assert.equal(recoveredInput?.cwd, "/tmp/project-opencode-v2-restart");
    assert.deepEqual(recoveredInput?.resumeCursor, convertedResumeCursor);

    yield* Scope.close(secondScope, Exit.void);
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);
