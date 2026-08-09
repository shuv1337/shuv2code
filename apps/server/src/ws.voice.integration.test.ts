import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VoiceClientSessionId,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceRuntimeInstanceId,
  VoiceTranscriptItemId,
  WS_METHODS,
} from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";

import type { AuthenticatedSession } from "./auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { VoiceControllerActionRepositoryLive } from "./persistence/Layers/VoiceControllerActions.ts";
import { VoiceControllerBindingRepositoryLive } from "./persistence/Layers/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepositoryLive } from "./persistence/Layers/VoiceControllerMutations.ts";
import { VoiceTransportSessionRepositoryLive } from "./persistence/Layers/VoiceTransportSessions.ts";
import { VoiceControllerActionRepository } from "./persistence/Services/VoiceControllerActions.ts";
import { VoiceControllerBindingRepository } from "./persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerMutationRepository } from "./persistence/Services/VoiceControllerMutations.ts";
import { VoiceTransportSessionRepository } from "./persistence/Services/VoiceTransportSessions.ts";
import * as ServerSettings from "./serverSettings.ts";
import { makeVoiceControllerActionRunner } from "./voice/Layers/VoiceControllerActionRunner.ts";
import { makeVoiceControllerService } from "./voice/Layers/VoiceControllerService.ts";
import { makeVoiceTargetMonitor } from "./voice/Layers/VoiceTargetMonitor.ts";
import { makeVoiceTransportCoordinator } from "./voice/Layers/VoiceTransportCoordinator.ts";
import { VoiceControllerActionRunner } from "./voice/Services/VoiceControllerActionRunner.ts";
import { VoiceTargetMonitor } from "./voice/Services/VoiceTargetMonitor.ts";
import { VoiceTransportCoordinator } from "./voice/Services/VoiceTransportCoordinator.ts";
import {
  VoiceRuntimeGateway,
  type VoiceRuntimeGatewayEvent,
  type VoiceRuntimeGatewayShape,
} from "./voice/Services/VoiceRuntimeGateway.ts";
import { makeVoiceWsRpcLayer, VoiceWsRpcGroup } from "./ws.ts";

const environmentId = EnvironmentId.make("voice-rpc-environment");
const hostProjectId = ProjectId.make("voice-rpc-project");
const targetThreadId = ThreadId.make("voice-rpc-target");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5",
  options: [],
} as const;
const now = "2026-07-30T00:00:00.000Z";

const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const voiceRepositories = Layer.mergeAll(
  VoiceControllerBindingRepositoryLive,
  VoiceTransportSessionRepositoryLive,
  VoiceControllerActionRepositoryLive,
  VoiceControllerMutationRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));

const mcpRegistry = McpSessionRegistry.layer.pipe(
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(NodeServices.layer),
);

const authenticatedSession = (
  suffix: string,
  scopes: AuthenticatedSession["scopes"],
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`voice-rpc-${suffix}`),
  subject: `voice-rpc-${suffix}`,
  method: "bearer-access-token",
  scopes,
});

describe("authenticated voice RPC vertical integration", () => {
  it.effect("enforces scopes and preserves fenced, exactly-bound controller actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositoryContext = yield* Layer.build(voiceRepositories);
        const mcpContext = yield* Layer.build(mcpRegistry);
        const registry = Context.get(mcpContext, McpSessionRegistry.McpSessionRegistry);
        const bindings = Context.get(repositoryContext, VoiceControllerBindingRepository);
        const transports = Context.get(repositoryContext, VoiceTransportSessionRepository);
        const actions = Context.get(repositoryContext, VoiceControllerActionRepository);
        const mutations = Context.get(repositoryContext, VoiceControllerMutationRepository);
        const runtimeEvents = yield* PubSub.unbounded<VoiceRuntimeGatewayEvent>();
        const controllerStarts: Array<
          Parameters<VoiceRuntimeGatewayShape["startControllerAction"]>[0]
        > = [];
        const controllerRuntimeEnsures: Array<
          Parameters<VoiceRuntimeGatewayShape["ensureControllerRuntime"]>[0]
        > = [];
        const stoppedTransports: Array<Parameters<VoiceRuntimeGatewayShape["stopTransport"]>[0]> =
          [];
        let controllerRuntimeGate:
          | {
              readonly entered: Deferred.Deferred<void>;
              readonly release: Deferred.Deferred<void>;
            }
          | undefined;
        let transportStartGate:
          | {
              readonly entered: Deferred.Deferred<void>;
              readonly release: Deferred.Deferred<void>;
            }
          | undefined;

        const runtime = VoiceRuntimeGateway.of({
          resolveModelSelection: () => Effect.succeed(modelSelection),
          ensureControllerRuntime: (input) =>
            Effect.gen(function* () {
              controllerRuntimeEnsures.push(input);
              const runtimeOrdinal = controllerRuntimeEnsures.length;
              const gate = controllerRuntimeGate;
              controllerRuntimeGate = undefined;
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
              const runtimeSequence = runtimeOrdinal <= 2 ? 1 : runtimeOrdinal - 1;
              const runtimeInstanceId = VoiceRuntimeInstanceId.make(
                `controller-runtime-${runtimeSequence}`,
              );
              const issued = yield* registry.issue({
                threadId: input.controllerThreadId,
                providerInstanceId: input.providerInstanceId,
                profile: {
                  kind: "voice-controller",
                  controllerThreadId: input.controllerThreadId,
                  runtimeInstanceId,
                  authorizedRuntimeCeiling: input.authorizedRuntimeCeiling,
                  liveControllerRuntimeMode: input.runtimeMode,
                  controlEpoch: input.controlEpoch,
                  controlEnabled: input.controlEnabled,
                },
              });
              return {
                codexProviderThreadId: `codex-controller-session-${runtimeSequence}`,
                runtimeInstanceId,
                controllerMcpCredentialId: issued.config.credentialId,
              };
            }),
          stopControllerRuntime: () => Effect.void,
          startTransport: (input) =>
            Effect.gen(function* () {
              const gate = transportStartGate;
              transportStartGate = undefined;
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
              return {
                codexProviderThreadId: "codex-transport-session-1",
                runtimeInstanceId: input.runtimeInstanceId,
                answerSdp: input.transportType === "websocket" ? null : "answer-sdp",
                transportType: input.transportType,
              };
            }),
          stopTransport: (input) =>
            Effect.sync(() => {
              stoppedTransports.push(input);
            }),
          listVoices: () =>
            Effect.succeed({
              voices: [
                { id: "marin", label: "Marin" },
                { id: "cedar", label: "Cedar" },
              ],
              defaultVoiceId: "marin",
            }),
          startControllerAction: (input) =>
            Effect.sync(() => {
              controllerStarts.push(input);
              return {
                codexProviderThreadId: "codex-controller-session-1",
                turnId: TurnId.make("controller-turn-1"),
              };
            }),
          awaitControllerAction: () =>
            Effect.succeed({
              status: "completed",
              speakableText: "The requested thread was created.",
            }),
          readThread: (threadId) =>
            Effect.succeed({
              threadId,
              turns: [
                {
                  id: TurnId.make("controller-history-turn-1"),
                  status: "completed",
                  items: [
                    {
                      id: "controller-history-user-1",
                      type: "userMessage",
                      content: [{ type: "text", text: "What is the target doing?" }],
                    },
                    {
                      id: "controller-history-commentary-1",
                      type: "agentMessage",
                      phase: "commentary",
                      text: "I am checking it.",
                    },
                    {
                      id: "controller-history-final-1",
                      type: "agentMessage",
                      phase: "final_answer",
                      text: "It is waiting for approval.",
                    },
                  ],
                },
              ],
            }),
          appendTransportText: () => Effect.void,
          appendTransportSpeech: () => Effect.void,
          appendTransportAudio: () => Effect.void,
          streamEvents: Stream.fromPubSub(runtimeEvents),
        });

        const projection = ProjectionSnapshotQuery.of({
          ...({} as ProjectionSnapshotQuery["Service"]),
          getProjectShellById: () =>
            Effect.succeed(
              Option.some({
                id: hostProjectId,
                title: "Voice RPC project",
                workspaceRoot: "/tmp/voice-rpc-project",
                defaultModelSelection: modelSelection,
                scripts: [],
                createdAt: now,
                updatedAt: now,
              }),
            ),
          getThreadDetailById: (threadId) =>
            Effect.succeed(
              Option.some({
                id: threadId,
                projectId: hostProjectId,
                title: threadId === targetThreadId ? "Current work" : "Voice controller",
                modelSelection,
                runtimeMode: "approval-required",
                purpose: threadId === targetThreadId ? "standard" : "voice-controller",
                deletedAt: null,
                archivedAt: null,
              } as never),
            ),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: now,
            }),
        });
        const engine = OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(1),
        });
        const settingsContext = yield* Layer.build(
          ServerSettings.layerTest({
            enableRealtimeVoice: true,
            enableVoiceThreadRead: true,
            enableVoiceThreadControl: true,
          }),
        );
        const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
        const transportCoordinator = yield* makeVoiceTransportCoordinator().pipe(
          Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(VoiceControllerBindingRepository, bindings),
          Effect.provideService(VoiceTransportSessionRepository, transports),
          Effect.provideService(VoiceControllerActionRepository, actions),
          Effect.provideService(VoiceRuntimeGateway, runtime),
          Effect.provide(NodeServices.layer),
        );
        const targetMonitor = yield* makeVoiceTargetMonitor().pipe(
          Effect.provideService(ProjectionSnapshotQuery, projection),
          Effect.provideService(VoiceControllerBindingRepository, bindings),
          Effect.provideService(VoiceControllerActionRepository, actions),
          Effect.provideService(VoiceControllerMutationRepository, mutations),
          Effect.provideService(VoiceTransportCoordinator, transportCoordinator),
        );
        const actionRunner = yield* makeVoiceControllerActionRunner().pipe(
          Effect.provideService(ProjectionSnapshotQuery, projection),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(VoiceControllerBindingRepository, bindings),
          Effect.provideService(VoiceControllerActionRepository, actions),
          Effect.provideService(VoiceControllerMutationRepository, mutations),
          Effect.provideService(ServerSettings.ServerSettingsService, settings),
          Effect.provideService(VoiceRuntimeGateway, runtime),
          Effect.provideService(VoiceTransportCoordinator, transportCoordinator),
          Effect.provideService(VoiceTargetMonitor, targetMonitor),
          Effect.provide(NodeServices.layer),
        );
        const voiceController = yield* makeVoiceControllerService().pipe(
          Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          Effect.provideService(ProjectionSnapshotQuery, projection),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(VoiceControllerBindingRepository, bindings),
          Effect.provideService(VoiceControllerMutationRepository, mutations),
          Effect.provideService(ServerSettings.ServerSettingsService, settings),
          Effect.provideService(VoiceRuntimeGateway, runtime),
          Effect.provideService(VoiceTransportCoordinator, transportCoordinator),
          Effect.provideService(VoiceTargetMonitor, targetMonitor),
          Effect.provideService(VoiceControllerActionRunner, actionRunner),
          Effect.provide(NodeServices.layer),
        );

        const fullClient = yield* RpcTest.makeClient(VoiceWsRpcGroup).pipe(
          Effect.provide(
            makeVoiceWsRpcLayer(
              authenticatedSession("full", [
                AuthOrchestrationReadScope,
                AuthOrchestrationOperateScope,
              ]),
              voiceController,
            ),
          ),
        );
        const readClient = yield* RpcTest.makeClient(VoiceWsRpcGroup).pipe(
          Effect.provide(
            makeVoiceWsRpcLayer(
              authenticatedSession("read", [AuthOrchestrationReadScope]),
              voiceController,
            ),
          ),
        );

        assert.deepStrictEqual(yield* readClient[WS_METHODS.voiceGetController]({}), {
          controller: null,
        });

        const deniedEnsure = yield* Effect.flip(
          readClient[WS_METHODS.voiceEnsureController]({
            hostProjectId,
            providerInstanceId,
            authorizedRuntimeCeiling: "approval-required",
          }),
        );
        assert.strictEqual(deniedEnsure._tag, "EnvironmentAuthorizationError");
        if (deniedEnsure._tag !== "EnvironmentAuthorizationError") return assert.fail();
        assert.strictEqual(deniedEnsure.requiredScope, AuthOrchestrationOperateScope);

        const ensured = yield* fullClient[WS_METHODS.voiceEnsureController]({
          hostProjectId,
          providerInstanceId,
          modelSelection,
          authorizedRuntimeCeiling: "approval-required",
        });
        assert.strictEqual(ensured.controller.state, "active");
        const controllerThreadId = ensured.controller.controllerThreadId;
        assert.strictEqual(controllerRuntimeEnsures[0]?.creationDisposition, "fresh");
        assert.deepStrictEqual(
          (yield* readClient[WS_METHODS.voiceGetController]({})).controller,
          ensured.controller,
        );
        const deniedReset = yield* Effect.flip(
          readClient[WS_METHODS.voiceResetController]({ controllerThreadId }),
        );
        assert.strictEqual(deniedReset._tag, "EnvironmentAuthorizationError");
        if (deniedReset._tag !== "EnvironmentAuthorizationError") return assert.fail();
        assert.strictEqual(deniedReset.requiredScope, AuthOrchestrationOperateScope);

        const deniedTarget = yield* Effect.flip(
          readClient[WS_METHODS.voiceSetControllerTarget]({
            controllerThreadId,
            targetThreadId,
          }),
        );
        assert.strictEqual(deniedTarget._tag, "EnvironmentAuthorizationError");
        if (deniedTarget._tag !== "EnvironmentAuthorizationError") return assert.fail();
        assert.strictEqual(deniedTarget.requiredScope, AuthOrchestrationOperateScope);

        assert.deepStrictEqual(
          yield* fullClient[WS_METHODS.voiceSetControllerTarget]({
            controllerThreadId,
            targetThreadId,
          }),
          { targetThreadId },
        );
        assert.strictEqual(
          Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).activeTargetThreadId,
          targetThreadId,
        );

        const recoveredEnsure = yield* fullClient[WS_METHODS.voiceEnsureController]({
          hostProjectId,
          providerInstanceId,
          modelSelection,
          authorizedRuntimeCeiling: "approval-required",
        });
        assert.strictEqual(recoveredEnsure.controller.controllerThreadId, controllerThreadId);
        assert.strictEqual(controllerRuntimeEnsures[1]?.creationDisposition, "recover");

        const catalog = yield* readClient[WS_METHODS.voiceListVoices]({ controllerThreadId });
        assert.deepStrictEqual(catalog, {
          voices: [
            { id: "marin", label: "Marin" },
            { id: "cedar", label: "Cedar" },
          ],
          defaultVoiceId: "marin",
        });

        const clientSessionId = VoiceClientSessionId.make("browser-voice-session");
        const generation = VoiceGeneration.make(1);
        const deniedStart = yield* Effect.flip(
          readClient[WS_METHODS.voiceStart]({
            controllerThreadId,
            clientSessionId,
            generation,
            offerSdp: "offer-sdp",
          }),
        );
        assert.strictEqual(deniedStart._tag, "EnvironmentAuthorizationError");
        if (deniedStart._tag !== "EnvironmentAuthorizationError") return assert.fail();
        assert.strictEqual(deniedStart.requiredScope, AuthOrchestrationOperateScope);

        const started = yield* fullClient[WS_METHODS.voiceStart]({
          controllerThreadId,
          clientSessionId,
          generation,
          offerSdp: "offer-sdp",
          voiceId: "marin",
        });
        assert.strictEqual(started.answerSdp, "answer-sdp");
        assert.strictEqual(started.eventCursor, VoiceEventSequence.make(1));

        const eventFiber = yield* readClient[WS_METHODS.subscribeVoiceEvents]({
          clientSessionId,
          generation,
          runtimeInstanceId: started.runtimeInstanceId,
          afterSequence: VoiceEventSequence.make(0),
        }).pipe(
          Stream.takeUntil(
            (event) =>
              event.payload.type === "action.status" && event.payload.state === "completed",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const runtimeFence = {
          controllerThreadId,
          transportThreadId: started.transportThreadId,
          clientSessionId,
          runtimeInstanceId: started.runtimeInstanceId,
          generation,
          realtimeSessionId: started.realtimeSessionId,
        };
        const deniedIngress = yield* Effect.flip(
          readClient[WS_METHODS.voiceIngestRealtimeEvent]({
            ...runtimeFence,
            event: {
              type: "handoff",
              handoffId: "denied-handoff",
              itemId: "denied-item",
              inputTranscript: "This must not start a controller action.",
            },
          }),
        );
        assert.strictEqual(deniedIngress._tag, "EnvironmentAuthorizationError");

        yield* PubSub.publish(runtimeEvents, {
          type: "transport.item-added",
          transportThreadId: runtimeFence.transportThreadId,
          runtimeInstanceId: runtimeFence.runtimeInstanceId,
          generation: runtimeFence.generation,
          realtimeSessionId: runtimeFence.realtimeSessionId,
          item: {
            type: "message",
            handoff_id: "malformed-handoff",
            item_id: "malformed-item",
            input_transcript: "This must not start a controller action.",
          },
        });
        yield* Effect.yieldNow;
        assert.lengthOf(controllerStarts, 0);

        const transcriptIngress = yield* fullClient[WS_METHODS.voiceIngestRealtimeEvent]({
          ...runtimeFence,
          event: {
            type: "transcript.done",
            itemId: VoiceTranscriptItemId.make("realtime-turn-1"),
            role: "user",
            text: "Create a real investigation thread and report its status.",
          },
        });
        assert.strictEqual(transcriptIngress.accepted, true);
        const handoffIngress = {
          ...runtimeFence,
          event: {
            type: "handoff" as const,
            handoffId: "handoff-1",
            itemId: "handoff-item-1",
            inputTranscript: "Create a real investigation thread and report its status.",
          },
        };
        assert.strictEqual(
          (yield* fullClient[WS_METHODS.voiceIngestRealtimeEvent](handoffIngress)).accepted,
          true,
        );
        assert.strictEqual(
          (yield* fullClient[WS_METHODS.voiceIngestRealtimeEvent](handoffIngress)).accepted,
          true,
        );

        const events = Array.from(yield* Fiber.join(eventFiber).pipe(Effect.timeout("2 seconds")));
        const actionEvents = events.filter((event) => event.payload.type === "action.status");
        assert.strictEqual(
          events.some(
            (event) =>
              event.payload.type === "transcript.done" &&
              event.payload.text === "Create a real investigation thread and report its status.",
          ),
          true,
        );
        assert.deepStrictEqual(
          actionEvents.map((event) =>
            event.payload.type === "action.status" ? event.payload.state : "impossible",
          ),
          ["queued", "controller-starting", "controller-working", "completed"],
        );
        assert.lengthOf(controllerStarts, 1);
        const controllerStart = controllerStarts[0]!;
        assert.strictEqual(controllerStart.recoveryPolicy, "forbid");
        assert.include(controllerStart.input, 'activeTargetThreadId="voice-rpc-target"');
        assert.include(controllerStart.input, "includeUntrustedContext=true");
        assert.include(
          controllerStart.input,
          "Create a real investigation thread and report its status.",
        );

        const persistedAction = Option.getOrThrow(
          yield* actions.getById(controllerStart.clientUserMessageId),
        );
        assert.strictEqual(persistedAction.voiceActionId, controllerStart.clientUserMessageId);
        assert.strictEqual(
          persistedAction.controllerProviderSessionId,
          "codex-controller-session-1",
        );
        assert.strictEqual(
          persistedAction.controllerProviderTurnId,
          TurnId.make("controller-turn-1"),
        );
        assert.strictEqual(persistedAction.state, "completed");

        const staleStop = yield* Effect.flip(
          fullClient[WS_METHODS.voiceStop]({
            controllerThreadId,
            transportThreadId: started.transportThreadId,
            clientSessionId,
            generation: VoiceGeneration.make(2),
            runtimeInstanceId: started.runtimeInstanceId,
            realtimeSessionId: started.realtimeSessionId,
          }),
        );
        assert.strictEqual(staleStop._tag, "VoiceControllerError");
        if (staleStop._tag !== "VoiceControllerError") return assert.fail();
        assert.strictEqual(staleStop.code, "stale_generation");
        assert.lengthOf(stoppedTransports, 0);

        const deniedStop = yield* Effect.flip(
          readClient[WS_METHODS.voiceStop]({
            controllerThreadId,
            transportThreadId: started.transportThreadId,
            clientSessionId,
            generation,
            runtimeInstanceId: started.runtimeInstanceId,
            realtimeSessionId: started.realtimeSessionId,
          }),
        );
        assert.strictEqual(deniedStop._tag, "EnvironmentAuthorizationError");

        const stopped = yield* fullClient[WS_METHODS.voiceStop]({
          controllerThreadId,
          transportThreadId: started.transportThreadId,
          clientSessionId,
          generation,
          runtimeInstanceId: started.runtimeInstanceId,
          realtimeSessionId: started.realtimeSessionId,
        });
        assert.isTrue(stopped.stopped);
        assert.lengthOf(stoppedTransports, 1);
        assert.deepStrictEqual(stoppedTransports[0], {
          transportThreadId: runtimeFence.transportThreadId,
          runtimeInstanceId: runtimeFence.runtimeInstanceId,
          generation: runtimeFence.generation,
          realtimeSessionId: runtimeFence.realtimeSessionId,
        });

        const lostRuntime = yield* transportCoordinator.getControllerRuntime(controllerThreadId);
        assert.isDefined(lostRuntime);
        if (lostRuntime === undefined) return assert.fail();
        const recoveryEntered = yield* Deferred.make<void>();
        const releaseRecovery = yield* Deferred.make<void>();
        controllerRuntimeGate = { entered: recoveryEntered, release: releaseRecovery };
        yield* PubSub.publish(runtimeEvents, {
          type: "controller.runtime-lost",
          controllerThreadId,
          runtimeInstanceId: lostRuntime.runtimeInstanceId,
        });
        yield* Deferred.await(recoveryEntered).pipe(Effect.timeout("2 seconds"));
        const concurrentEnsureFiber = yield* fullClient[WS_METHODS.voiceEnsureController]({
          hostProjectId,
          providerInstanceId,
          modelSelection,
          authorizedRuntimeCeiling: "approval-required",
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.lengthOf(controllerRuntimeEnsures, 3);
        yield* Deferred.succeed(releaseRecovery, undefined);
        const concurrentEnsure = yield* Fiber.join(concurrentEnsureFiber).pipe(
          Effect.timeout("2 seconds"),
        );
        assert.strictEqual(concurrentEnsure.controller.state, "active");
        assert.lengthOf(controllerRuntimeEnsures, 4);
        assert.strictEqual(
          Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).state,
          "active",
        );
        assert.strictEqual(
          (yield* transportCoordinator.getControllerRuntime(controllerThreadId))?.runtimeInstanceId,
          VoiceRuntimeInstanceId.make("controller-runtime-3"),
        );

        const history = yield* readClient[WS_METHODS.voiceGetControllerHistory]({
          controllerThreadId,
        });
        assert.strictEqual(history.controllerThreadId, controllerThreadId);
        assert.deepStrictEqual(
          history.messages.map(({ role, text }) => ({ role, text })),
          [
            { role: "user", text: "What is the target doing?" },
            { role: "assistant", text: "It is waiting for approval." },
          ],
        );
        assert.strictEqual(controllerRuntimeEnsures[4]?.creationDisposition, "recover");

        const ensureEntered = yield* Deferred.make<void>();
        const releaseEnsure = yield* Deferred.make<void>();
        controllerRuntimeGate = { entered: ensureEntered, release: releaseEnsure };
        const ensureFiber = yield* fullClient[WS_METHODS.voiceEnsureController]({
          hostProjectId,
          providerInstanceId,
          modelSelection,
          authorizedRuntimeCeiling: "approval-required",
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(ensureEntered).pipe(Effect.timeout("2 seconds"));
        const resetFiber = yield* fullClient[WS_METHODS.voiceResetController]({
          controllerThreadId,
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.strictEqual(
          Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).state,
          "active",
        );
        yield* Deferred.succeed(releaseEnsure, undefined);
        assert.strictEqual((yield* Fiber.join(ensureFiber)).controller.state, "active");
        assert.isTrue((yield* Fiber.join(resetFiber).pipe(Effect.timeout("2 seconds"))).reset);
        assert.isTrue(Option.isNone(yield* bindings.getByEnvironmentId(environmentId)));
        assert.isUndefined(yield* transportCoordinator.getControllerRuntime(controllerThreadId));

        const reEnsured = yield* fullClient[WS_METHODS.voiceEnsureController]({
          hostProjectId,
          providerInstanceId,
          modelSelection,
          authorizedRuntimeCeiling: "approval-required",
        });
        const restartedControllerThreadId = reEnsured.controller.controllerThreadId;
        const transportEntered = yield* Deferred.make<void>();
        const releaseTransport = yield* Deferred.make<void>();
        transportStartGate = { entered: transportEntered, release: releaseTransport };
        const startFiber = yield* fullClient[WS_METHODS.voiceStart]({
          controllerThreadId: restartedControllerThreadId,
          clientSessionId: VoiceClientSessionId.make("concurrent-start-session"),
          generation: VoiceGeneration.make(1),
          offerSdp: "concurrent-offer-sdp",
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(transportEntered).pipe(Effect.timeout("2 seconds"));
        const concurrentResetFiber = yield* fullClient[WS_METHODS.voiceResetController]({
          controllerThreadId: restartedControllerThreadId,
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.strictEqual(
          Option.getOrThrow(yield* bindings.getByEnvironmentId(environmentId)).state,
          "active",
        );
        yield* Deferred.succeed(releaseTransport, undefined);
        assert.strictEqual((yield* Fiber.join(startFiber)).answerSdp, "answer-sdp");
        assert.isTrue(
          (yield* Fiber.join(concurrentResetFiber).pipe(Effect.timeout("2 seconds"))).reset,
        );
        assert.isTrue(Option.isNone(yield* bindings.getByEnvironmentId(environmentId)));
        assert.isUndefined(
          yield* transportCoordinator.getControllerRuntime(restartedControllerThreadId),
        );
      }),
    ),
  );
});
