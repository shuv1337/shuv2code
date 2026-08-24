import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VoiceActionId,
  VoiceGeneration,
  VoiceRealtimeSessionId,
  VoiceRuntimeInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { McpSessionRegistry, type McpCredentialRequest } from "../../mcp/McpSessionRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderRealtimeStartInput } from "../../provider/Services/ProviderAdapter.ts";
import type { ProviderCreationRecoveryInput } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeVoiceRuntimeGateway } from "./VoiceRuntimeGateway.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const now = "2026-07-30T00:00:00.000Z" as ProviderSession["createdAt"];
const modelSelection = { instanceId, model: "gpt-5.4" } as const;

function makeHarness(
  models: ServerProvider["models"] = [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  voices: ReadonlyArray<{ readonly id: string; readonly label?: string }> = [
    { id: "juniper" },
    { id: "cove" },
  ],
  voiceUnsupportedReason?:
    | "feature_disabled"
    | "method_unavailable"
    | "incompatible_version"
    | "empty_voice_catalog",
  failRealtimeStart = false,
  controllerRecovery:
    | { readonly state: "adopted" }
    | { readonly state: "not_found" }
    | { readonly state: "ambiguous"; readonly candidateCount: number } = { state: "adopted" },
  codexVersion: string | null = "0.146.0",
  realtimeStartNotification: "sdp" | "error" | "closed" = "sdp",
  providerOverrides: Partial<ProviderService["Service"]> = {},
) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ProviderSession>();
    const starts: Array<{ readonly threadId: ThreadId; readonly input: Record<string, unknown> }> =
      [];
    const realtimeStarts: Array<ProviderRealtimeStartInput> = [];
    const recoveries: Array<ProviderCreationRecoveryInput> = [];
    const stops: Array<ThreadId> = [];
    const credentialRequests: Array<McpCredentialRequest> = [];
    const threadSnapshots = new Map<
      ThreadId,
      ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
        readonly status?: "completed" | "interrupted" | "failed" | "inProgress";
      }>
    >();
    let activeControllerScope: McpInvocationScope | undefined;

    const openSession = (
      threadId: ThreadId,
      input: Parameters<ProviderService["Service"]["startSession"]>[1],
    ) => {
      if (input.controllerGrant !== undefined) {
        const standardRequest = {
          threadId,
          providerInstanceId: input.providerInstanceId ?? instanceId,
        } satisfies McpCredentialRequest;
        const controllerRequest = {
          threadId,
          providerInstanceId: input.providerInstanceId ?? instanceId,
          profile: {
            kind: "voice-controller",
            controllerThreadId: input.controllerGrant.controllerThreadId,
            runtimeInstanceId: VoiceRuntimeInstanceId.make(input.controllerGrant.runtimeInstanceId),
            authorizedRuntimeCeiling: input.controllerGrant.authorizedRuntimeCeiling,
            liveControllerRuntimeMode: input.controllerGrant.liveControllerRuntimeMode,
            controlEpoch: input.controllerGrant.controlEpoch,
            controlEnabled: input.controllerGrant.controlEnabled,
          },
        } satisfies McpCredentialRequest;
        credentialRequests.push(standardRequest, controllerRequest);
        McpProviderSession.clearMcpProviderSession(threadId);
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-standard-live",
          environmentId: "environment-test" as never,
          threadId,
          providerSessionId: "pending-provider-session-standard",
          providerInstanceId: input.providerInstanceId ?? instanceId,
          profile: { kind: "standard-provider" },
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: "Bearer standard-token-live",
        });
        const profile = {
          kind: "voice-controller" as const,
          controllerThreadId: input.controllerGrant.controllerThreadId,
          runtimeInstanceId: VoiceRuntimeInstanceId.make(input.controllerGrant.runtimeInstanceId),
          providerIdentity: {
            codexProviderThreadId: `codex:${threadId}`,
          },
          scope: {
            kind: "managed-codex-environment" as const,
            environmentId: "environment-test" as never,
          },
          authorizedRuntimeCeiling: input.controllerGrant.authorizedRuntimeCeiling,
          liveControllerRuntimeMode: input.controllerGrant.liveControllerRuntimeMode,
          controlEpoch: input.controllerGrant.controlEpoch,
        };
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-controller-live",
          environmentId: "environment-test" as never,
          threadId,
          providerSessionId: "pending-provider-session-controller",
          providerInstanceId: input.providerInstanceId ?? instanceId,
          profile,
          endpoint: "http://127.0.0.1/mcp/controller",
          authorizationHeader: "Bearer controller-token-live",
        });
        activeControllerScope = {
          credentialId: "credential-controller-live",
          environmentId: "environment-test" as never,
          threadId,
          providerSessionId: "pending-provider-session-controller",
          providerInstanceId: input.providerInstanceId ?? instanceId,
          profile,
          capabilities: new Set([
            "threads.read",
            ...(input.controllerGrant.controlEnabled ? (["threads.control"] as const) : []),
          ]),
          issuedAt: 1,
        };
      }
      const session = {
        provider: codex,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.modelSelection !== undefined ? { model: input.modelSelection.model } : {}),
        threadId,
        runtimeInstanceId: input.runtimeInstanceId,
        providerSessionId: `session:${threadId}`,
        providerThreadId: `codex:${threadId}`,
        createdAt: now,
        updatedAt: now,
      } satisfies ProviderSession;
      sessions.set(threadId, session);
      return session;
    };

    const provider = ProviderService.of({
      startSession: (threadId, input) =>
        Effect.sync(() => {
          starts.push({ threadId, input });
          return openSession(threadId, input);
        }),
      recoverCreatedSession: (input) =>
        Effect.sync(() => {
          recoveries.push(input);
          if (controllerRecovery.state !== "adopted") {
            return controllerRecovery;
          }
          return {
            state: "adopted" as const,
            session: openSession(input.threadId, input),
          };
        }),
      sendTurn: vi.fn(() =>
        Effect.succeed({
          threadId: ThreadId.make("controller"),
          turnId: "turn-1" as never,
        }),
      ),
      steerTurn: vi.fn(() =>
        Effect.succeed({
          threadId: ThreadId.make("controller"),
          turnId: "turn-1" as never,
        }),
      ),
      startRealtime: (input) =>
        Effect.gen(function* () {
          realtimeStarts.push(input);
          if (failRealtimeStart) {
            return yield* Effect.fail(new Error("realtime start failed") as never);
          }
          yield* Effect.yieldNow;
          const eventBase = {
            eventId: EventId.make("event-sdp"),
            provider: codex,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            createdAt: now,
          } as const;
          const route = {
            runtimeInstanceId: sessions.get(input.threadId)?.runtimeInstanceId ?? "",
            generation: input.generation,
            realtimeSessionId: input.realtimeSessionId,
            ingressSequence: 2,
          } as const;
          yield* PubSub.publish(
            events,
            realtimeStartNotification === "sdp"
              ? {
                  ...eventBase,
                  type: "thread.realtime.sdp",
                  payload: { sdp: "answer-sdp", ...route },
                }
              : realtimeStartNotification === "error"
                ? {
                    ...eventBase,
                    type: "thread.realtime.error",
                    payload: { message: "provider rejected startup", ...route },
                  }
                : {
                    ...eventBase,
                    type: "thread.realtime.closed",
                    payload: { reason: "provider closed startup", ...route },
                  },
          );
        }),
      appendRealtimeText: vi.fn(() => Effect.void),
      appendRealtimeSpeech: vi.fn(() => Effect.void),
      appendRealtimeAudio: vi.fn(() => Effect.void),
      stopRealtime: vi.fn(() => Effect.void),
      listRealtimeVoices: vi.fn(() =>
        Effect.succeed({
          voices,
          defaultVoiceId: voices.some((voice) => voice.id === "cove") ? "cove" : null,
          ...(voiceUnsupportedReason !== undefined
            ? { unsupportedReason: voiceUnsupportedReason }
            : {}),
        }),
      ),
      interruptTurn: vi.fn(() => Effect.void),
      compactThread: vi.fn(() => Effect.void),
      respondToRequest: vi.fn(() => Effect.void),
      respondToUserInput: vi.fn(() => Effect.void),
      stopSession: ({ threadId }) =>
        Effect.sync(() => {
          stops.push(threadId);
          sessions.delete(threadId);
        }),
      listSessions: () => Effect.sync(() => Array.from(sessions.values())),
      readThread: vi.fn((threadId) =>
        Effect.succeed({
          threadId,
          turns: threadSnapshots.get(threadId) ?? [],
        }),
      ),
      getCapabilities: vi.fn(() =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
          turnSteering: "same-turn" as const,
        }),
      ),
      hasDurableSessionRecovery: vi.fn(() => Effect.succeed(false)),
      getInstanceInfo: vi.fn(() =>
        Effect.succeed({
          instanceId,
          driverKind: codex,
          displayName: "Codex",
          enabled: true,
          continuationIdentity: { kind: "provider-native" } as never,
        }),
      ),
      rollbackConversation: vi.fn(() => Effect.void),
      streamEvents: Stream.fromPubSub(events),
      ...providerOverrides,
    });

    const registry = McpSessionRegistry.of({
      issue: (request) =>
        Effect.sync(() => {
          credentialRequests.push(request);
          const controller = request.profile?.kind === "voice-controller";
          return {
            config: {
              credentialId: "credential-controller",
              environmentId: "environment-test" as never,
              threadId: request.threadId,
              providerSessionId: "pending-provider-session",
              providerInstanceId: request.providerInstanceId,
              profile: controller
                ? {
                    kind: "voice-controller",
                    controllerThreadId: request.profile.controllerThreadId,
                    runtimeInstanceId: request.profile.runtimeInstanceId,
                    providerIdentity: undefined,
                    scope: {
                      kind: "managed-codex-environment",
                      environmentId: "environment-test" as never,
                    },
                    authorizedRuntimeCeiling: request.profile.authorizedRuntimeCeiling,
                    liveControllerRuntimeMode: request.profile.liveControllerRuntimeMode,
                    controlEpoch: request.profile.controlEpoch,
                  }
                : { kind: "standard-provider" },
              endpoint: controller ? "http://127.0.0.1/mcp/controller" : "http://127.0.0.1/mcp",
              authorizationHeader: "Bearer test-token",
            },
          };
        }),
      resolve: vi.fn((token: string) =>
        Effect.succeed(token === "controller-token-live" ? activeControllerScope : undefined),
      ),
      bindControllerProviderIdentity: vi.fn(() => Effect.succeed(true)),
      touch: vi.fn(() => Effect.void),
      revokeCredential: vi.fn(() => Effect.void),
      revokeProviderSession: vi.fn(() => Effect.void),
      revokeThread: vi.fn(() => Effect.void),
      revokeThreadProfile: vi.fn(() => Effect.void),
      revokeAll: Effect.void,
    });
    const providerRegistry = ProviderRegistry.of({
      getProviders: Effect.succeed([
        {
          instanceId,
          driver: codex,
          enabled: true,
          installed: true,
          version: codexVersion,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: now,
          availability: "available",
          models,
          slashCommands: [],
          skills: [],
        },
      ]),
      refresh: vi.fn(() => Effect.succeed([])),
      refreshInstance: vi.fn(() => Effect.succeed([])),
      getProviderMaintenanceCapabilitiesForInstance: vi.fn(() =>
        Effect.succeed({ supportedActions: [] } as never),
      ),
      setProviderMaintenanceActionState: vi.fn(() => Effect.succeed([])),
      streamChanges: Stream.empty,
    });

    const gateway = yield* makeVoiceRuntimeGateway().pipe(
      Effect.provideService(ProviderService, provider),
      Effect.provideService(McpSessionRegistry, registry),
      Effect.provideService(ProviderRegistry, providerRegistry),
    );
    yield* Effect.yieldNow;
    return {
      gateway,
      starts,
      recoveries,
      realtimeStarts,
      credentialRequests,
      stops,
      events,
      sessions,
      threadSnapshots,
    };
  });
}

describe("VoiceRuntimeGateway", () => {
  it.effect("preserves the durable runtime fence and negotiates v3 transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runtimeInstanceId = VoiceRuntimeInstanceId.make("runtime-transport");
        const opened = yield* harness.gateway.startTransport({
          transportThreadId: ThreadId.make("transport"),
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          runtimeInstanceId,
          generation: VoiceGeneration.make(3),
          realtimeSessionId: VoiceRealtimeSessionId.make("realtime-3"),
          realtimeModel: "gpt-live-1-codex",
          transportType: "webrtc",
          offerSdp: "offer-sdp",
          clientManagedHandoffs: true,
        });

        assert.strictEqual(opened.runtimeInstanceId, runtimeInstanceId);
        assert.strictEqual(opened.answerSdp, "answer-sdp");
        assert.strictEqual(opened.transportType, "webrtc");
        assert.strictEqual(harness.starts[0]?.input.runtimeInstanceId, runtimeInstanceId);
        assert.strictEqual(harness.starts[0]?.input.threadPurpose, "voice-transport");
        assert.strictEqual(harness.starts[0]?.input.enableRealtimeConversation, true);
        assert.strictEqual(harness.realtimeStarts[0]?.clientManagedHandoffs, true);
        assert.strictEqual(harness.realtimeStarts[0]?.model, "gpt-live-1-codex");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("settles a controller action from exact persisted provider history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller-history-fallback");
        const controller = yield* harness.gateway.ensureControllerRuntime({
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          creationDisposition: "fresh",
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access",
          controlEpoch: 1,
          controlEnabled: true,
        });
        const started = yield* harness.gateway.startControllerAction({
          controllerThreadId,
          controllerRuntimeInstanceId: controller.runtimeInstanceId,
          input: "Create one thread.",
          clientUserMessageId: VoiceActionId.make("voice-action-history"),
          recoveryPolicy: "forbid",
        });
        harness.threadSnapshots.set(controllerThreadId, [
          {
            id: started.turnId,
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "assistant-1",
                phase: "final_answer",
                text: "The thread was created.",
              },
            ],
          },
        ]);

        const outcome = yield* harness.gateway.awaitControllerAction({
          controllerThreadId,
          controllerRuntimeInstanceId: controller.runtimeInstanceId,
          turnId: started.turnId,
        });

        assert.deepStrictEqual(outcome, {
          status: "completed",
          speakableText: "The thread was created.",
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("prefers exact persisted history over a conflicting terminal event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller-history-authority");
        const controller = yield* harness.gateway.ensureControllerRuntime({
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          creationDisposition: "fresh",
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access",
          controlEpoch: 1,
          controlEnabled: true,
        });
        const started = yield* harness.gateway.startControllerAction({
          controllerThreadId,
          controllerRuntimeInstanceId: controller.runtimeInstanceId,
          input: "Read one thread.",
          clientUserMessageId: VoiceActionId.make("voice-action-history-authority"),
          recoveryPolicy: "forbid",
        });
        yield* PubSub.publish(harness.events, {
          type: "turn.completed",
          eventId: EventId.make("event-conflicting-terminal"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: controllerThreadId,
          turnId: started.turnId,
          createdAt: "2026-07-30T00:00:00.000Z",
          payload: { state: "failed" },
        });
        yield* Effect.yieldNow;
        harness.threadSnapshots.set(controllerThreadId, [
          {
            id: started.turnId,
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "assistant-authoritative",
                phase: "final_answer",
                text: "The target is waiting for approval.",
              },
            ],
          },
        ]);

        const outcome = yield* harness.gateway.awaitControllerAction({
          controllerThreadId,
          controllerRuntimeInstanceId: controller.runtimeInstanceId,
          turnId: started.turnId,
        });

        assert.deepStrictEqual(outcome, {
          status: "completed",
          speakableText: "The target is waiting for approval.",
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("does not settle on a transient interrupted history snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller-transient-interrupted");
        const controller = yield* harness.gateway.ensureControllerRuntime({
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          creationDisposition: "fresh",
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access",
          controlEpoch: 1,
          controlEnabled: true,
        });
        const started = yield* harness.gateway.startControllerAction({
          controllerThreadId,
          controllerRuntimeInstanceId: controller.runtimeInstanceId,
          input: "Steer the active target.",
          clientUserMessageId: VoiceActionId.make("voice-action-transient-interrupted"),
          recoveryPolicy: "forbid",
        });
        harness.threadSnapshots.set(controllerThreadId, [
          { id: started.turnId, status: "interrupted", items: [] },
        ]);
        const waiting = yield* harness.gateway
          .awaitControllerAction({
            controllerThreadId,
            controllerRuntimeInstanceId: controller.runtimeInstanceId,
            turnId: started.turnId,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("500 millis");
        harness.threadSnapshots.set(controllerThreadId, [
          { id: started.turnId, status: "inProgress", items: [] },
        ]);
        yield* TestClock.adjust("750 millis");
        harness.threadSnapshots.set(controllerThreadId, [
          {
            id: started.turnId,
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "assistant-transient",
                phase: "final_answer",
                text: "The active turn was steered.",
              },
            ],
          },
        ]);
        yield* TestClock.adjust("1 second");

        const outcome = yield* Fiber.join(waiting);
        assert.deepStrictEqual(outcome, {
          status: "completed",
          speakableText: "The active turn was steered.",
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("stops the provider transport when realtime negotiation startup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(undefined, undefined, undefined, true);
        const transportThreadId = ThreadId.make("transport-failed-negotiation");
        const error = yield* Effect.flip(
          harness.gateway.startTransport({
            transportThreadId,
            providerInstanceId: instanceId,
            cwd: "/tmp/project",
            modelSelection,
            runtimeMode: "approval-required",
            runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-failed-negotiation"),
            generation: VoiceGeneration.make(1),
            realtimeSessionId: VoiceRealtimeSessionId.make("realtime-failed-negotiation"),
            realtimeModel: "gpt-live-1-codex",
            transportType: "webrtc",
            offerSdp: "offer-sdp",
            clientManagedHandoffs: true,
          }),
        );
        assert.strictEqual(error.code, "realtime_start_failed");
        assert.deepStrictEqual(harness.stops, [transportThreadId]);
        assert.strictEqual(harness.sessions.has(transportThreadId), false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails fast and stops the provider transport on a fenced startup error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          "error",
        );
        const transportThreadId = ThreadId.make("transport-rejected-negotiation");
        const error = yield* Effect.flip(
          harness.gateway.startTransport({
            transportThreadId,
            providerInstanceId: instanceId,
            cwd: "/tmp/project",
            modelSelection,
            runtimeMode: "approval-required",
            runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-rejected-negotiation"),
            generation: VoiceGeneration.make(1),
            realtimeSessionId: VoiceRealtimeSessionId.make("realtime-rejected-negotiation"),
            realtimeModel: "gpt-live-1-codex",
            transportType: "webrtc",
            offerSdp: "offer-sdp",
            clientManagedHandoffs: true,
          }),
        );
        assert.strictEqual(error.code, "realtime_start_rejected");
        assert.deepStrictEqual(harness.stops, [transportThreadId]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds a nonterminating provider stop finalizer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          {
            stopRealtime: () => Effect.never,
            stopSession: () => Effect.never,
          },
        );
        const transportThreadId = ThreadId.make("transport-nonterminating-stop");
        const runtimeInstanceId = VoiceRuntimeInstanceId.make("runtime-nonterminating-stop");
        yield* harness.gateway.startTransport({
          transportThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          runtimeInstanceId,
          generation: VoiceGeneration.make(1),
          realtimeSessionId: VoiceRealtimeSessionId.make("realtime-nonterminating-stop"),
          realtimeModel: "gpt-live-1-codex",
          transportType: "webrtc",
          offerSdp: "offer-sdp",
          clientManagedHandoffs: true,
        });

        const stopped = yield* harness.gateway
          .stopTransport({
            transportThreadId,
            runtimeInstanceId,
            generation: VoiceGeneration.make(1),
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("11 seconds");

        yield* Fiber.join(stopped);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("mints the controller credential from the exact live binding grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller");
        const opened = yield* harness.gateway.ensureControllerRuntime({
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "auto-accept-edits",
          creationDisposition: "fresh",
          bindingGeneration: 4,
          authorizedRuntimeCeiling: "full-access",
          controlEpoch: 9,
          controlEnabled: true,
        });

        const request = harness.credentialRequests.find(
          (candidate) => candidate.profile?.kind === "voice-controller",
        );
        assert.strictEqual(request?.profile?.kind, "voice-controller");
        if (request?.profile?.kind !== "voice-controller") {
          return assert.fail("expected voice-controller credential");
        }
        assert.strictEqual(request.profile.runtimeInstanceId, opened.runtimeInstanceId);
        assert.strictEqual(request.profile.authorizedRuntimeCeiling, "full-access");
        assert.strictEqual(request.profile.liveControllerRuntimeMode, "auto-accept-edits");
        assert.strictEqual(request.profile.controlEpoch, 9);
        assert.strictEqual(request.profile.controlEnabled, true);
        assert.strictEqual(harness.starts[0]?.input.recoveryPolicy, "forbid");
        assert.strictEqual(harness.starts[0]?.input.threadPurpose, "voice-controller");
        assert.strictEqual(harness.starts[0]?.input.runtimeInstanceId, opened.runtimeInstanceId);
        assert.deepStrictEqual(
          (
            harness.starts[0]?.input.controllerGrant as
              | { readonly controlEpoch: number }
              | undefined
          )?.controlEpoch,
          9,
        );
        assert.strictEqual(opened.controllerMcpCredentialId, "credential-controller-live");
        assert.deepStrictEqual(
          McpProviderSession.readMcpProviderSessions(controllerThreadId)
            .map((config) => config.profile.kind)
            .sort(),
          ["standard-provider", "voice-controller"],
        );
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("uses the unique advertised Codex default when no project selection applies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const selected = yield* harness.gateway.resolveModelSelection(instanceId);
        assert.deepStrictEqual(selected, modelSelection);
        const voices = yield* harness.gateway.listVoices(ThreadId.make("controller"));
        assert.deepStrictEqual(
          voices.voices.map((voice) => voice.id),
          ["juniper", "cove"],
        );
        assert.strictEqual(voices.defaultVoiceId, "cove");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an unadvertised preferred model and a catalog without one default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness([
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isCustom: false,
            capabilities: null,
          },
        ]);
        const invalidPreferred = yield* Effect.flip(
          harness.gateway.resolveModelSelection(instanceId, {
            instanceId,
            model: "not-advertised",
          }),
        );
        assert.strictEqual(invalidPreferred.code, "model_unavailable");
        const missingDefault = yield* Effect.flip(
          harness.gateway.resolveModelSelection(instanceId),
        );
        assert.strictEqual(missingDefault.code, "default_model_missing");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects missing, invalid, and older Codex versions before opening voice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const version of [null, "not-semver", "0.145.9"] as const) {
          const harness = yield* makeHarness(
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            version,
          );
          const error = yield* Effect.flip(harness.gateway.resolveModelSelection(instanceId));
          assert.strictEqual(error.code, "incompatible_version");
          assert.strictEqual(harness.starts.length, 0);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a structured reason for an empty v3-compatible voice catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(undefined, []);
        const error = yield* Effect.flip(harness.gateway.listVoices(ThreadId.make("controller")));
        assert.strictEqual(error.code, "empty_voice_catalog");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves structured realtime capability probe reasons", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const reason of [
          "feature_disabled",
          "method_unavailable",
          "incompatible_version",
        ] as const) {
          const harness = yield* makeHarness(undefined, [], reason);
          const error = yield* Effect.flip(
            harness.gateway.listVoices(ThreadId.make(`controller-${reason}`)),
          );
          assert.strictEqual(error.code, reason);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to exact thread source when no provider cursor was persisted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller-recover-exact");
        const opened = yield* harness.gateway.ensureControllerRuntime({
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required",
          creationDisposition: "recover",
          bindingGeneration: 7,
          authorizedRuntimeCeiling: "full-access",
          controlEpoch: 3,
          controlEnabled: true,
        });

        assert.strictEqual(harness.starts.length, 0);
        assert.strictEqual(harness.recoveries.length, 1);
        assert.strictEqual(
          harness.recoveries[0]?.threadSource,
          "shuv2code/voice-controller/controller-recover-exact/v7",
        );
        assert.strictEqual("resumeCursor" in (harness.recoveries[0] ?? {}), false);
        assert.strictEqual("recoveryPolicy" in (harness.recoveries[0] ?? {}), false);
        assert.strictEqual(harness.recoveries[0]?.runtimeInstanceId, opened.runtimeInstanceId);
        assert.strictEqual(opened.codexProviderThreadId, `codex:${controllerThreadId}`);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("fails closed without a fresh start when controller recovery finds no match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(undefined, undefined, undefined, false, {
          state: "not_found",
        });
        const error = yield* harness.gateway
          .ensureControllerRuntime({
            controllerThreadId: ThreadId.make("controller-recover-missing"),
            providerInstanceId: instanceId,
            cwd: "/tmp/project",
            modelSelection,
            runtimeMode: "approval-required",
            creationDisposition: "recover",
            bindingGeneration: 1,
            authorizedRuntimeCeiling: "full-access",
            controlEpoch: 0,
            controlEnabled: false,
          })
          .pipe(Effect.flip);

        assert.strictEqual(error.code, "controller_creation_not_found");
        assert.strictEqual(harness.starts.length, 0);
        assert.strictEqual(harness.recoveries.length, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed without a fresh start when controller recovery is ambiguous", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(undefined, undefined, undefined, false, {
          state: "ambiguous",
          candidateCount: 2,
        });
        const error = yield* harness.gateway
          .ensureControllerRuntime({
            controllerThreadId: ThreadId.make("controller-recover-ambiguous"),
            providerInstanceId: instanceId,
            cwd: "/tmp/project",
            modelSelection,
            runtimeMode: "approval-required",
            creationDisposition: "recover",
            bindingGeneration: 1,
            authorizedRuntimeCeiling: "full-access",
            controlEpoch: 0,
            controlEnabled: false,
          })
          .pipe(Effect.flip);

        assert.strictEqual(error.code, "controller_creation_ambiguous");
        assert.strictEqual(harness.starts.length, 0);
        assert.strictEqual(harness.recoveries.length, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses only an exact controller grant and rotates after an epoch change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const base = {
          controllerThreadId: ThreadId.make("controller-rotation"),
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required" as const,
          creationDisposition: "fresh" as const,
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access" as const,
          controlEnabled: true,
        };
        const first = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          controlEpoch: 1,
        });
        const active = harness.sessions.get(base.controllerThreadId);
        if (active === undefined) {
          return assert.fail("expected the controller session to be active");
        }
        harness.sessions.set(base.controllerThreadId, {
          ...active,
          // Codex may report a canonical provider model slug that differs from
          // the requested catalog slug. Reuse is fenced by the request the
          // gateway actually opened, not this provider presentation field.
          model: "canonical-provider-model",
        });
        const reused = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          creationDisposition: "recover",
          controlEpoch: 1,
        });
        assert.strictEqual(reused.runtimeInstanceId, first.runtimeInstanceId);
        assert.strictEqual(harness.starts.length, 1);

        const rotated = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          creationDisposition: "recover",
          controlEpoch: 2,
        });
        assert.notStrictEqual(rotated.runtimeInstanceId, first.runtimeInstanceId);
        assert.strictEqual(harness.starts.length, 1);
        assert.strictEqual(harness.recoveries.length, 1);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("rotates a controller instead of silently reusing a different model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const base = {
          controllerThreadId: ThreadId.make("controller-model-rotation"),
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          runtimeMode: "approval-required" as const,
          creationDisposition: "fresh" as const,
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access" as const,
          controlEpoch: 1,
          controlEnabled: true,
        };
        const first = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          modelSelection,
        });
        const rotated = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          creationDisposition: "recover",
          modelSelection: { instanceId, model: "gpt-5.5" },
        });
        assert.notStrictEqual(rotated.runtimeInstanceId, first.runtimeInstanceId);
        assert.strictEqual(harness.starts.length, 1);
        assert.strictEqual(harness.recoveries.length, 1);
        assert.strictEqual(
          (harness.recoveries[0]?.modelSelection as { readonly model?: string } | undefined)?.model,
          "gpt-5.5",
        );
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("ignores a late exit from a rotated controller runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const harness = yield* makeHarness();
        const controllerThreadId = ThreadId.make("controller-late-exit");
        const base = {
          controllerThreadId,
          providerInstanceId: instanceId,
          cwd: "/tmp/project",
          modelSelection,
          runtimeMode: "approval-required" as const,
          creationDisposition: "fresh" as const,
          bindingGeneration: 1,
          authorizedRuntimeCeiling: "full-access" as const,
          controlEnabled: true,
        };
        const oldRuntime = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          controlEpoch: 1,
        });
        const currentRuntime = yield* harness.gateway.ensureControllerRuntime({
          ...base,
          creationDisposition: "recover",
          controlEpoch: 2,
        });
        const eventFiber = yield* harness.gateway.streamEvents.pipe(
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.events, {
          eventId: EventId.make("old-runtime-exit"),
          provider: codex,
          providerInstanceId: instanceId,
          threadId: controllerThreadId,
          createdAt: now,
          type: "session.exited",
          payload: {
            reason: "late old exit",
            runtimeInstanceId: oldRuntime.runtimeInstanceId,
          },
        });
        yield* Effect.yieldNow;
        yield* PubSub.publish(harness.events, {
          eventId: EventId.make("current-runtime-exit"),
          provider: codex,
          providerInstanceId: instanceId,
          threadId: controllerThreadId,
          createdAt: now,
          type: "session.exited",
          payload: {
            reason: "current exit",
            runtimeInstanceId: currentRuntime.runtimeInstanceId,
          },
        });
        const event = yield* Fiber.join(eventFiber).pipe(Effect.timeout("1 second"));
        assert.strictEqual(Option.isSome(event), true);
        if (Option.isSome(event)) {
          assert.strictEqual(event.value.type, "controller.runtime-lost");
          assert.strictEqual(event.value.runtimeInstanceId, currentRuntime.runtimeInstanceId);
        }
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
      Effect.provide(NodeServices.layer),
    ),
  );
});
