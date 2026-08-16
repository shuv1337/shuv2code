import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(new Set(["preview", "automations"]));

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect(
  "keeps ordinary and controller credentials together while rejecting cross-profile bearer use",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const threadId = ThreadId.make("controller-thread");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const standard = yield* registry.issue({ threadId, providerInstanceId });
      const controller = yield* registry.issue({
        threadId,
        providerInstanceId,
        profile: {
          kind: "voice-controller",
          controllerThreadId: threadId,
          runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-1"),
          authorizedRuntimeCeiling: "full-access",
          liveControllerRuntimeMode: "full-access",
          controlEpoch: 7,
          controlEnabled: true,
        },
      });
      const standardToken = standard.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const controllerToken = controller.config.authorizationHeader.replace(/^Bearer\s+/, "");

      expect(standard.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
      expect(controller.config.endpoint).toBe("http://127.0.0.1:43123/mcp/controller");
      expect((yield* registry.resolve(standardToken, "standard-provider"))?.profile?.kind).toBe(
        "standard-provider",
      );
      expect((yield* registry.resolve(controllerToken, "voice-controller"))?.profile?.kind).toBe(
        "voice-controller",
      );
      expect(yield* registry.resolve(standardToken, "voice-controller")).toBeUndefined();
      expect(yield* registry.resolve(controllerToken, "standard-provider")).toBeUndefined();
    }),
);

it.effect("never grants threads.read or threads.control to a non-controller provider session", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const standard = yield* registry.issue({
      threadId: ThreadId.make("standard-no-thread-caps"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = standard.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token, "standard-provider");

    expect(resolved?.profile.kind).toBe("standard-provider");
    expect(resolved?.capabilities).toEqual(new Set(["preview", "automations"]));
    expect(resolved?.capabilities.has("threads.read")).toBe(false);
    expect(resolved?.capabilities.has("threads.control")).toBe(false);
    expect(yield* registry.resolve(token, "voice-controller")).toBeUndefined();
  }),
);

it.effect("issues and provider-binds an explicitly granted durable thread controller", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("durable-controller-thread");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      profile: {
        kind: "durable-thread-controller",
        controllerThreadId: threadId,
        authorizedRuntimeCeiling: "auto-accept-edits",
        controlEnabled: true,
      },
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp/controller");
    expect(
      yield* registry.bindControllerProviderIdentity(issued.config.credentialId, {
        codexProviderThreadId: "provider-thread-1",
      }),
    ).toBe(true);

    const resolved = yield* registry.resolve(token, "durable-thread-controller");
    expect(resolved?.profile).toMatchObject({
      kind: "durable-thread-controller",
      controllerThreadId: threadId,
      providerIdentity: { providerThreadId: "provider-thread-1" },
      authorizedRuntimeCeiling: "auto-accept-edits",
      controlEnabled: true,
    });
    expect(resolved?.capabilities).toEqual(new Set(["threads.read", "threads.control"]));
    expect(yield* registry.resolve(token, "standard-provider")).toBeUndefined();
  }),
);

it.effect("replaces only the matching profile for a thread", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("profile-replacement-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const originalStandard = yield* registry.issue({ threadId, providerInstanceId });
    const controller = yield* registry.issue({
      threadId,
      providerInstanceId,
      profile: {
        kind: "voice-controller",
        controllerThreadId: threadId,
        runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-2"),
        authorizedRuntimeCeiling: "full-access",
        liveControllerRuntimeMode: "full-access",
        controlEpoch: 1,
        controlEnabled: true,
      },
    });
    const replacementStandard = yield* registry.issue({ threadId, providerInstanceId });
    const token = (issued: McpSessionRegistry.McpIssuedCredential) =>
      issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    expect(yield* registry.resolve(token(originalStandard))).toBeUndefined();
    expect(yield* registry.resolve(token(replacementStandard), "standard-provider")).toBeDefined();
    expect(yield* registry.resolve(token(controller), "voice-controller")).toBeDefined();
  }),
);

it.effect("revokes one thread profile without disturbing its ordinary credential", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("selective-profile-revocation");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const standard = yield* registry.issue({ threadId, providerInstanceId });
    const controller = yield* registry.issue({
      threadId,
      providerInstanceId,
      profile: {
        kind: "durable-thread-controller",
        controllerThreadId: threadId,
        authorizedRuntimeCeiling: "full-access",
        controlEnabled: true,
      },
    });
    const token = (issued: McpSessionRegistry.McpIssuedCredential) =>
      issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* registry.revokeThreadProfile(threadId, "durable-thread-controller");

    expect(yield* registry.resolve(token(controller))).toBeUndefined();
    expect(yield* registry.resolve(token(standard), "standard-provider")).toBeDefined();
  }),
);
