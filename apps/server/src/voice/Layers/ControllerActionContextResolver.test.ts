import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadControlInvocationResolver } from "../../orchestration/Services/ThreadControlInvocationResolver.ts";
import { __testing as threadHandlerTesting } from "../../mcp/toolkits/threads/handlers.ts";
import { VoiceControllerActionRepositoryLive } from "../../persistence/Layers/VoiceControllerActions.ts";
import { VoiceControllerBindingRepositoryLive } from "../../persistence/Layers/VoiceControllerBindings.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VoiceTransportSessionRepositoryLive } from "../../persistence/Layers/VoiceTransportSessions.ts";
import { VoiceControllerActionRepository } from "../../persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceTransportSessionRepository } from "../../persistence/Services/VoiceTransportSessions.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeVoiceThreadControlInvocationResolver } from "../VoiceThreadControlInvocationResolver.ts";
import { ControllerActionContextResolverLive } from "./ControllerActionContextResolver.ts";
import { ControllerActionContextResolver } from "../Services/ControllerActionContextResolver.ts";

const environmentId = EnvironmentId.make("environment-controller-action-resolver");
const controllerThreadId = ThreadId.make("controller-thread-action-resolver");
const hostProjectId = ProjectId.make("host-project-action-resolver");
const providerInstanceId = ProviderInstanceId.make("codex");
const controllerRuntimeInstanceId = VoiceRuntimeInstanceId.make("controller-runtime-1");
const providerThreadId = "provider-thread-1";
const transportSessionId = "transport-session-1";
const transportRuntimeInstanceId = "transport-runtime-1";
const now = "2026-07-30T00:00:00.000Z";

const repositories = Layer.mergeAll(
  VoiceControllerActionRepositoryLive,
  VoiceControllerBindingRepositoryLive,
  VoiceTransportSessionRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const services = ControllerActionContextResolverLive.pipe(Layer.provideMerge(repositories));

const layer = it.layer(services);

const resetVoiceRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM voice_controller_actions`;
  yield* sql`DELETE FROM voice_transport_sessions`;
  yield* sql`DELETE FROM voice_controller_bindings`;
});

const openControllerScope = Effect.gen(function* () {
  const bindings = yield* VoiceControllerBindingRepository;
  const transports = yield* VoiceTransportSessionRepository;
  const reserved = yield* bindings.reserve({
    environmentId,
    controllerThreadId,
    hostProjectId,
    providerInstanceId,
    authorizedRuntimeCeiling: "full-access",
    bindingGeneration: 1,
    controlEpoch: 0,
    createdAt: now,
  });
  assert.strictEqual(reserved._tag, "created");
  assert.isTrue(
    yield* bindings.compareAndSetState({
      environmentId,
      expectedControllerThreadId: reserved.binding.controllerThreadId,
      expectedBindingGeneration: reserved.binding.bindingGeneration,
      expectedState: "provisioning",
      nextState: "active",
      expectedControlEpoch: 0,
      updatedAt: now,
    }),
  );

  const opened = yield* transports.openOrReplay({
    transportSessionId,
    environmentId,
    controllerThreadId,
    transportThreadId: ThreadId.make("transport-thread-1"),
    runtimeInstanceId: transportRuntimeInstanceId,
    generation: 1,
    createdAt: now,
  });
  assert.strictEqual(opened._tag, "created");
  assert.isTrue(
    yield* transports.activate({
      transportSessionId,
      generation: 1,
      runtimeInstanceId: transportRuntimeInstanceId,
      realtimeSessionId: "realtime-session-1",
      updatedAt: now,
    }),
  );
});

const createBoundAction = (voiceActionId: string, turnId: string) =>
  Effect.gen(function* () {
    const actions = yield* VoiceControllerActionRepository;
    const created = yield* actions.createOrReplay({
      voiceActionId,
      environmentId,
      controllerThreadId,
      transportSessionId,
      transportRuntimeInstanceId,
      transportGeneration: 1,
      handoffId: `handoff-${voiceActionId}`,
      handoffItemId: `handoff-item-${voiceActionId}`,
      clientUserMessageId: voiceActionId,
      controllerRuntimeInstanceId,
      createdAt: now,
    });
    assert.strictEqual(created._tag, "created");
    const bound = yield* actions.bindControllerTurn({
      voiceActionId,
      controllerProviderSessionId: providerThreadId,
      controllerProviderTurnId: TurnId.make(turnId),
      boundAt: now,
    });
    assert.strictEqual(bound._tag, "bound");
  });

const resolve = (
  overrides: {
    readonly controllerThreadId?: ThreadId;
    readonly controllerRuntimeInstanceId?: VoiceRuntimeInstanceId;
    readonly codexProviderThreadId?: string;
    readonly providerTurnId?: TurnId;
  } = {},
) =>
  Effect.gen(function* () {
    const resolver = yield* ControllerActionContextResolver;
    return yield* resolver.resolve({
      controllerThreadId: overrides.controllerThreadId ?? controllerThreadId,
      controllerRuntimeInstanceId:
        overrides.controllerRuntimeInstanceId ?? controllerRuntimeInstanceId,
      codexProviderThreadId: overrides.codexProviderThreadId ?? providerThreadId,
      providerTurnId: overrides.providerTurnId ?? TurnId.make("turn-a"),
    });
  });

const invocation = {
  credentialId: "controller-credential-1",
  environmentId,
  threadId: controllerThreadId,
  providerSessionId: "mcp-bookkeeping-session",
  providerInstanceId,
  profile: {
    kind: "voice-controller" as const,
    controllerThreadId,
    runtimeInstanceId: controllerRuntimeInstanceId,
    providerIdentity: { codexProviderThreadId: providerThreadId },
    scope: { kind: "managed-codex-environment" as const, environmentId },
    authorizedRuntimeCeiling: "full-access" as const,
    liveControllerRuntimeMode: "full-access" as const,
    controlEpoch: 0,
  },
  capabilities: new Set(["threads.read", "threads.control"] as const),
  issuedAt: 1,
};

const provideMcpRequest = <A, E, R>(effect: Effect.Effect<A, E, R>, turnId: string | undefined) =>
  Effect.gen(function* () {
    const actionResolver = yield* ControllerActionContextResolver;
    const bindingRepository = yield* VoiceControllerBindingRepository;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const invocationResolver = makeVoiceThreadControlInvocationResolver({
      invocation,
      request: {
        turnMetadata:
          turnId === undefined
            ? undefined
            : {
                turnId,
                sessionId: providerThreadId,
                threadId: ThreadId.make(providerThreadId),
              },
      },
      settingsService,
      bindingRepository,
      actionResolver,
    });
    return yield* effect.pipe(
      Effect.provideService(ThreadControlInvocationResolver, invocationResolver),
    );
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableVoiceThreadRead: true,
        enableVoiceThreadControl: true,
      }),
    ),
  );

layer("ControllerActionContextResolverLive", (it) => {
  it.effect("resolves delayed turn A after turn B is active on the same controller runtime", () =>
    Effect.gen(function* () {
      yield* resetVoiceRows;
      yield* openControllerScope;
      yield* createBoundAction("action-a", "turn-a");
      yield* createBoundAction("action-b", "turn-b");

      const delayed = yield* resolve();
      const current = yield* resolve({ providerTurnId: TurnId.make("turn-b") });

      expect(delayed.voiceActionId).toBe("action-a");
      expect(delayed.controllerProviderTurnId).toBe("turn-a");
      expect(current.voiceActionId).toBe("action-b");
      expect(current.controllerProviderTurnId).toBe("turn-b");
    }),
  );

  it.effect("rejects wrong controller runtime, provider session, and provider turn", () =>
    Effect.gen(function* () {
      yield* resetVoiceRows;
      yield* openControllerScope;
      yield* createBoundAction("action-a", "turn-a");

      for (const request of [
        {
          controllerRuntimeInstanceId: VoiceRuntimeInstanceId.make("controller-runtime-replaced"),
        },
        { codexProviderThreadId: "provider-thread-other" },
        { providerTurnId: TurnId.make("turn-other") },
      ]) {
        const error = yield* resolve(request).pipe(Effect.flip);
        expect(error.code).toBe("action_not_found");
      }
    }),
  );

  it.effect("rejects a closed action and a fenced transport generation", () =>
    Effect.gen(function* () {
      const actions = yield* VoiceControllerActionRepository;

      yield* resetVoiceRows;
      yield* openControllerScope;
      yield* createBoundAction("action-closed", "turn-a");
      assert.isTrue(
        yield* actions.close({
          voiceActionId: "action-closed",
          terminalState: "completed",
          closedAt: now,
        }),
      );
      expect((yield* resolve().pipe(Effect.flip)).code).toBe("action_not_found");

      yield* resetVoiceRows;
      yield* openControllerScope;
      yield* createBoundAction("action-fenced", "turn-a");
      expect(
        yield* actions.fenceTransportGeneration({
          transportSessionId,
          throughGeneration: 1,
          closedAt: now,
        }),
      ).toBe(1);
      expect((yield* resolve().pipe(Effect.flip)).code).toBe("action_not_found");
    }),
  );

  it.effect("binds MCP mutation context to the exact delayed turn and never falls back", () =>
    Effect.gen(function* () {
      yield* resetVoiceRows;
      yield* openControllerScope;
      yield* createBoundAction("action-a", "turn-a");
      yield* createBoundAction("action-b", "turn-b");

      const delayed = yield* provideMcpRequest(threadHandlerTesting.requireAction(), "turn-a");
      expect(delayed.action.voiceActionId).toBe("action-a");
      expect(delayed.action.controllerProviderTurnId).toBe("turn-a");

      const proactiveError = yield* provideMcpRequest(
        threadHandlerTesting.requireAction(),
        undefined,
      ).pipe(Effect.flip);
      expect(proactiveError).toMatchObject({
        _tag: "ThreadControlInvocationError",
        code: "action_not_found",
      });
    }),
  );
});
