import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ThreadControlService } from "../orchestration/Services/ThreadControlService.ts";
import { VoiceControllerBindingRepository } from "../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerBinding } from "../persistence/VoiceControlModels.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ControllerActionContextResolver } from "../voice/Services/ControllerActionContextResolver.ts";
import * as ControllerMcpHttpServer from "./ControllerMcpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-controller-http-test");
const controllerThreadId = ThreadId.make("controller-thread-http-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const codexProviderThreadId = "codex-provider-thread-http-test";

const fakeEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  }),
);

const bindingRepository = VoiceControllerBindingRepository.of({
  reserve: () => Effect.die("unused"),
  getByEnvironmentId: () => Effect.die("unused"),
  getByControllerThreadId: () =>
    Effect.succeed(
      Option.some(
        VoiceControllerBinding.make({
          environmentId,
          controllerThreadId,
          activeTargetThreadId: null,
          hostProjectId: ProjectId.make("host-project"),
          providerInstanceId,
          authorizedRuntimeCeiling: "full-access",
          bindingGeneration: 1,
          controlEpoch: 1,
          state: "active",
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        }),
      ),
    ),
  compareAndSetState: () => Effect.die("unused"),
  rotateControlEpoch: () => Effect.die("unused"),
  incrementControlEpoch: () => Effect.die("unused"),
  setActiveTarget: () => Effect.die("unused"),
  clearActiveTargetIfMatches: () => Effect.die("unused"),
  deleteResetting: () => Effect.die("unused"),
});

const threadControl = ThreadControlService.of({
  list: () =>
    Effect.succeed({
      snapshotSequence: 41,
      projects: [],
      threads: [],
      nextCursor: null,
    }),
  get: () => Effect.die("unused"),
  create: () => Effect.die("mutation must be rejected before dispatch"),
  send: () => Effect.die("unused"),
  interrupt: () => Effect.die("unused"),
});

const ControllerServices = Layer.mergeAll(
  ServerSettings.layerTest({
    enableVoiceThreadRead: true,
    enableVoiceThreadControl: true,
  }),
  Layer.succeed(VoiceControllerBindingRepository, bindingRepository),
  Layer.succeed(
    ControllerActionContextResolver,
    ControllerActionContextResolver.of({ resolve: () => Effect.die("unused") }),
  ),
  Layer.succeed(ThreadControlService, threadControl),
);

const postJsonRpc = (authorizationHeader: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const encodedBody = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(body).pipe(
      Effect.orDie,
    );
    const response = yield* client.post("/mcp/controller", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: authorizationHeader,
      },
      body: HttpBody.text(encodedBody, "application/json"),
    });
    return {
      status: response.status,
      body: yield* response.json,
    };
  });

it.effect("serves only the five controller tools and enforces profile and turn metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.__testing
        .make()
        .pipe(Effect.provide(Layer.merge(NodeServices.layer, fakeEnvironment)));
      const routes = ControllerMcpHttpServer.layer.pipe(
        Layer.provide(ControllerServices),
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
      );
      yield* HttpRouter.serve(routes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const standard = yield* registry.issue({
        threadId: controllerThreadId,
        providerInstanceId,
      });
      const controller = yield* registry.issue({
        threadId: controllerThreadId,
        providerInstanceId,
        profile: {
          kind: "voice-controller",
          controllerThreadId,
          runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-http-test"),
          authorizedRuntimeCeiling: "full-access",
          liveControllerRuntimeMode: "full-access",
          controlEpoch: 1,
          controlEnabled: true,
        },
      });
      expect(
        yield* registry.bindControllerProviderIdentity(controller.config.credentialId, {
          codexProviderThreadId,
        }),
      ).toBe(true);

      const wrongProfile = yield* postJsonRpc(standard.config.authorizationHeader, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(wrongProfile.status).toBe(401);

      const listed = yield* postJsonRpc(controller.config.authorizationHeader, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(listed.status).toBe(200);
      const listedBody = listed.body as {
        readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
      };
      expect(listedBody.result.tools.map(({ name }) => name).sort()).toEqual([
        "thread_create",
        "thread_get",
        "thread_interrupt",
        "thread_list",
        "thread_send",
      ]);

      const read = yield* postJsonRpc(controller.config.authorizationHeader, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "thread_list", arguments: {} },
      });
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        result: {
          isError: false,
          structuredContent: { snapshotSequence: 41 },
        },
      });

      const mutationWithoutMetadata = yield* postJsonRpc(controller.config.authorizationHeader, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "thread_create",
          arguments: {
            projectId: "project-http-test",
            initialInstruction: "Create a real thread.",
          },
        },
      });
      expect(mutationWithoutMetadata.status).toBe(200);
      expect(mutationWithoutMetadata.body).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: {
              _tag: "ControllerActionContextError",
              code: "action_not_found",
            },
          },
        },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it("retains only allowlisted, matching Codex turn metadata", () => {
  const invocation = {
    credentialId: "credential-metadata-test",
    environmentId,
    threadId: controllerThreadId,
    providerSessionId: "random-mcp-bookkeeping-id",
    providerInstanceId,
    profile: {
      kind: "voice-controller" as const,
      controllerThreadId,
      runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-metadata-test"),
      providerIdentity: { codexProviderThreadId },
      scope: { kind: "managed-codex-environment" as const, environmentId },
      authorizedRuntimeCeiling: "full-access" as const,
      liveControllerRuntimeMode: "full-access" as const,
      controlEpoch: 1,
    },
    capabilities: new Set(["threads.read", "threads.control"] as const),
    issuedAt: 1,
  };
  const extracted = ControllerMcpHttpServer.extractControllerTurnMetadata(
    {
      "x-codex-turn-metadata": {
        turn_id: "provider-turn-1",
        session_id: codexProviderThreadId,
        thread_id: codexProviderThreadId,
        turn_started_at_unix_ms: 1_754_000_000_000,
        secret: "must-not-survive",
      },
      unrelated: { secret: "must-not-survive" },
    },
    invocation,
  );

  expect(extracted).toEqual({
    _tag: "valid",
    metadata: {
      turnId: "provider-turn-1",
      sessionId: codexProviderThreadId,
      threadId: codexProviderThreadId,
      turnStartedAtUnixMs: 1_754_000_000_000,
    },
  });

  expect(() =>
    ControllerMcpHttpServer.extractControllerTurnMetadata(
      {
        "x-codex-turn-metadata": {
          turn_id: "provider-turn-2",
          session_id: "different-provider-thread",
          thread_id: "different-provider-thread",
          turn_started_at_unix_ms: 1_754_000_000_001,
        },
      },
      invocation,
    ),
  ).toThrow("does not match this credential");
});
