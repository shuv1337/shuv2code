import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@shuv2code/contracts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import type { OpenCodeV2Client, OpenCodeV2Event } from "../opencodeV2Client.ts";

import {
  decodeOpenCodeV2Form,
  decodeOpenCodeV2Permission,
  decodeOpenCodeV2PermissionReply,
  decodeOpenCodeV2ResumeCursor,
  makeOpenCodeV2Adapter,
  mapOpenCodeV2PermissionToRequestType,
  mapOpenCodeV2FormToQuestions,
  openCodeV2EventSessionId,
  toOpenCodeV2FormAnswer,
} from "./OpenCodeV2Adapter.ts";

describe("OpenCodeV2Adapter permission classification", () => {
  it("keeps every provider permission actionable", () => {
    NodeAssert.equal(
      mapOpenCodeV2PermissionToRequestType("external_directory"),
      "dynamic_tool_call",
    );
    NodeAssert.equal(mapOpenCodeV2PermissionToRequestType("webfetch"), "dynamic_tool_call");
    NodeAssert.equal(
      mapOpenCodeV2PermissionToRequestType("future_permission"),
      "dynamic_tool_call",
    );
    NodeAssert.equal(mapOpenCodeV2PermissionToRequestType(undefined), "dynamic_tool_call");
  });

  it("preserves specific request types when OpenCode supplies one", () => {
    NodeAssert.equal(mapOpenCodeV2PermissionToRequestType("shell"), "command_execution_approval");
    NodeAssert.equal(mapOpenCodeV2PermissionToRequestType("read"), "file_read_approval");
    NodeAssert.equal(mapOpenCodeV2PermissionToRequestType("write"), "file_change_approval");
  });
});

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("not used"),
  connectToOpenCodeServer: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: null,
      external: true,
      protocol: "v2",
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () => Effect.die("not used"),
  loadInventoryFromCli: () => Effect.die("not used"),
};

const OPEN_CODE_V2_SETTINGS = {
  enabled: true,
  binaryPath: "opencode",
  serverUrl: "http://127.0.0.1:4301",
  serverPassword: "",
  customModels: [],
} as const;

function makeAdoptionClient(input: {
  readonly messages: () => Promise<unknown>;
  readonly events: ReadonlyArray<OpenCodeV2Event>;
  readonly models?: () => Promise<unknown>;
}): OpenCodeV2Client {
  return {
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "server.connected" };
          yield* input.events;
          await new Promise<never>(() => undefined);
        },
      }),
    },
    session: {
      get: async (sessionID: string) => ({ id: sessionID }),
      messages: input.messages,
    },
    model: { list: input.models ?? (async () => ({ data: [] })) },
    form: { list: async () => [] },
    permission: { list: async () => [] },
  } as unknown as OpenCodeV2Client;
}

function runAdoptedToolCompletion(input: {
  readonly messages: () => Promise<unknown>;
  readonly expectedTitle: string;
  readonly expectedEventCount: number;
}) {
  return Effect.gen(function* () {
    const threadId = ThreadId.make(`thread-${input.expectedTitle}`);
    const client = makeAdoptionClient({
      messages: input.messages,
      events: [
        {
          type: "session.tool.success",
          data: { sessionID: "ses_adopted", callID: "call_1" },
        },
      ],
    });
    const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
      clientFactory: () => client,
    });
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId && event.type.startsWith("item.")),
      Stream.take(input.expectedEventCount),
      Stream.runCollect,
      Effect.forkChild,
    );

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("opencodeV2"),
      threadId,
      runtimeMode: "full-access",
      resumeCursor: {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_adopted",
      },
    });

    const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
    NodeAssert.equal(events.length, input.expectedEventCount);
    for (const event of events) {
      if (event.type === "item.started" || event.type === "item.completed") {
        NodeAssert.equal(event.payload.title, input.expectedTitle);
      }
    }
  }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer));
}

const OpenCodeRuntimeTestDoubleLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble);
const OpenCodeV2AdapterTestLayer = Layer.merge(
  OpenCodeRuntimeTestDoubleLayer,
  ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(Layer.provideMerge(NodeServices.layer)),
);

describe("OpenCodeV2Adapter terminal state", () => {
  it.effect("attaches a newly granted controller without replacing the live event stream", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-v2-live-controller-attach");
      const providerInstanceId = ProviderInstanceId.make("opencodeV2");
      const mcpCalls: Array<readonly [string, unknown]> = [];
      let subscribeCount = 0;
      const client = {
        event: {
          subscribe: () => {
            subscribeCount += 1;
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "server.connected" };
                await new Promise<never>(() => undefined);
              },
            };
          },
        },
        session: {
          get: async () => ({ id: "ses_v2_live_controller_attach" }),
          messages: async () => ({ data: [], cursor: {} }),
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
        mcp: {
          add: async (name: string, config: unknown) => {
            mcpCalls.push([name, config]);
            return {};
          },
        },
      } as unknown as OpenCodeV2Client;
      const base = {
        environmentId: EnvironmentId.make("environment-v2-live-controller-attach"),
        threadId,
        providerInstanceId,
      };
      McpProviderSession.setMcpProviderSession({
        ...base,
        credentialId: "standard-credential-1",
        providerSessionId: "standard-session-1",
        profile: { kind: "standard-provider" },
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer standard-token-1",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );

      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const resumeCursor = {
        kind: "opencode-v2" as const,
        schemaVersion: 1 as const,
        sessionId: "ses_v2_live_controller_attach",
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId,
        threadId,
        runtimeMode: "approval-required",
        resumeCursor,
      });

      McpProviderSession.setMcpProviderSession({
        ...base,
        credentialId: "controller-credential",
        providerSessionId: "controller-session",
        profile: {
          kind: "durable-thread-controller",
          controllerThreadId: threadId,
          providerIdentity: undefined,
          authorizedRuntimeCeiling: "full-access",
          controlEnabled: true,
        },
        endpoint: "http://127.0.0.1:3773/mcp/controller",
        authorizationHeader: "Bearer controller-token",
      });
      const restarted = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor,
      });

      NodeAssert.equal(subscribeCount, 1);
      NodeAssert.equal(restarted.providerThreadId, "ses_v2_live_controller_attach");
      NodeAssert.equal(restarted.runtimeMode, "full-access");
      NodeAssert.deepEqual(
        mcpCalls.map(([name]) => name),
        ["shuv2code", "shuv2code", "shuv2code_controller"],
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(OpenCodeRuntime, {
            ...OpenCodeRuntimeTestDouble,
            connectToOpenCodeServer: () =>
              Effect.succeed({
                url: "http://127.0.0.1:4301",
                exitCode: null,
                external: false,
                sharedService: true,
                protocol: "v2",
              }),
          }),
          ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("re-registers controller MCP servers before forwarding a recovered approval", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-v2-controller-mcp");
      const mcpCalls: Array<readonly [string, unknown]> = [];
      const permissionReplies: Array<readonly [string, string, string]> = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          get: async () => ({ id: "ses_v2_controller_mcp" }),
          messages: async () => ({ data: [], cursor: {} }),
        },
        form: { list: async () => [] },
        permission: {
          list: async () => [
            {
              id: "per_v2_controller_mcp",
              sessionID: "ses_v2_controller_mcp",
              action: "external_directory",
              resources: ["/home/user/.shuv2code/userdata/attachments/*"],
            },
          ],
          reply: async (sessionID: string, requestID: string, reply: string) => {
            permissionReplies.push([sessionID, requestID, reply]);
          },
        },
        mcp: {
          add: async (name: string, config: unknown) => {
            mcpCalls.push([name, config]);
            return {};
          },
        },
      } as unknown as OpenCodeV2Client;
      const providerInstanceId = ProviderInstanceId.make("opencodeV2");
      const base = {
        environmentId: EnvironmentId.make("environment-v2-controller-mcp"),
        threadId,
        providerInstanceId,
      };
      McpProviderSession.setMcpProviderSession({
        ...base,
        credentialId: "standard-credential",
        providerSessionId: "standard-session",
        profile: { kind: "standard-provider" },
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer standard-token",
      });
      McpProviderSession.setMcpProviderSession({
        ...base,
        credentialId: "controller-credential",
        providerSessionId: "controller-session",
        profile: {
          kind: "durable-thread-controller",
          controllerThreadId: threadId,
          providerIdentity: undefined,
          authorizedRuntimeCeiling: "full-access",
          controlEnabled: true,
        },
        endpoint: "http://127.0.0.1:3773/mcp/controller",
        authorizationHeader: "Bearer controller-token",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );

      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        providerInstanceId,
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_v2_controller_mcp",
        },
      });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("per_v2_controller_mcp"),
        "accept",
      );

      NodeAssert.deepEqual(mcpCalls, [
        [
          "shuv2code",
          {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp",
            headers: { Authorization: "Bearer standard-token" },
            oauth: false,
          },
        ],
        [
          "shuv2code_controller",
          {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp/controller",
            headers: { Authorization: "Bearer controller-token" },
            oauth: false,
          },
        ],
      ]);
      NodeAssert.deepEqual(permissionReplies, [
        ["ses_v2_controller_mcp", "per_v2_controller_mcp", "once"],
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(OpenCodeRuntime, {
            ...OpenCodeRuntimeTestDouble,
            connectToOpenCodeServer: () =>
              Effect.succeed({
                url: "http://127.0.0.1:4301",
                exitCode: null,
                external: false,
                sharedService: true,
                protocol: "v2",
              }),
          }),
          ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps unsupported permission rules out of the v2 session payload", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-full-access-permissions");
      let createBody: unknown;
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async (body: unknown) => {
            createBody = body;
            return { id: "ses_full_access" };
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });

      NodeAssert.deepEqual(createBody, {
        location: { directory: process.cwd() },
      });
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("clears stale prompts when resuming full access", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resumed-full-access-permissions");
      const replies: Array<readonly [string, string, string]> = [];
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [],
      });
      client.permission.list = async () => [
        {
          id: "per_stale",
          sessionID: "ses_adopted",
          action: "external_directory",
          resources: ["/home/user/.shuv2code/worktrees/project/*"],
        },
      ];
      client.permission.reply = async (sessionID, requestID, reply) => {
        replies.push([sessionID, requestID, reply]);
      };
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      NodeAssert.deepEqual(replies, [["ses_adopted", "per_stale", "always"]]);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("projects OpenCode V2 compaction completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-v2-compacted");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.compaction.ended",
            data: { sessionID: "ses_adopted" },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const compactedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "thread.state.changed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      const events = Array.from(yield* Fiber.join(compactedEvent).pipe(Effect.timeout("1 second")));
      const event = events[0];
      NodeAssert.equal(event?.type, "thread.state.changed");
      if (event?.type === "thread.state.changed") {
        NodeAssert.equal(event.payload.state, "compacted");
      }
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("removes the active turn from the session after successful execution", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-successful-execution");
      let completeExecution: (() => void) | undefined;
      const executionCompleted = new Promise<void>((resolve) => {
        completeExecution = resolve;
      });
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await executionCompleted;
              yield {
                type: "session.execution.succeeded",
                data: { sessionID: "ses_successful_execution" },
              };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_successful_execution" }),
          switchModel: async () => undefined,
          prompt: async () => {
            completeExecution?.();
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "complete successfully",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
      });
      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));

      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.deepEqual(session?.resumeCursor, {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_successful_execution",
      });
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("emits current context usage after a successful execution", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-v2-context-usage");
      let messageReads = 0;
      const client = makeAdoptionClient({
        messages: async () => {
          messageReads += 1;
          return { data: [], cursor: {} };
        },
        events: [
          {
            type: "session.usage.updated",
            data: {
              sessionID: "ses_adopted",
              cost: 0,
              tokens: {
                input: 1_000,
                output: 250,
                reasoning: 125,
                cache: { read: 4_000, write: 500 },
              },
            },
          },
          {
            type: "session.execution.succeeded",
            data: { sessionID: "ses_adopted" },
          },
        ],
        models: async () => ({
          data: [
            {
              id: "gpt-5.6-sol",
              providerID: "openai",
              limit: { context: 258_400 },
            },
          ],
        }),
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const usageEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      const events = Array.from(
        yield* Fiber.join(usageEventFiber).pipe(Effect.timeout("1 second")),
      );
      const usageEvent = events[0];
      NodeAssert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        NodeAssert.equal(usageEvent.payload.usage.usedTokens, 5_250);
        NodeAssert.equal(usageEvent.payload.usage.maxTokens, 258_400);
      }
      NodeAssert.equal(messageReads, 1);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("recovers a missing terminal finish event without replaying the user prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing-terminal-recovery");
      let releaseFailure: (() => void) | undefined;
      const promptAccepted = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const prompts: string[] = [];
      const recoveries: unknown[] = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await promptAccepted;
              yield {
                type: "session.execution.failed",
                data: {
                  sessionID: "ses_missing_terminal_recovery",
                  error: {
                    type: "provider.invalid-output",
                    message: "Provider stream ended without a terminal finish event",
                  },
                },
              };
              yield {
                type: "session.execution.started",
                data: { sessionID: "ses_missing_terminal_recovery" },
              };
              yield {
                type: "session.execution.succeeded",
                data: { sessionID: "ses_missing_terminal_recovery" },
              };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_missing_terminal_recovery" }),
          switchModel: async () => undefined,
          prompt: async (_sessionID: string, body: { text: string }) => {
            prompts.push(body.text);
            releaseFailure?.();
          },
          synthetic: async (_sessionID: string, body: unknown) => {
            recoveries.push(body);
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" || event.type === "turn.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "finish the work",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(prompts, ["finish the work"]);
      NodeAssert.equal(recoveries.length, 1);
      NodeAssert.deepEqual(recoveries[0], {
        text: "The provider stream ended before sending a terminal finish event. Continue the interrupted response from the current durable session state. Do not repeat completed tool calls or other completed work. If the response was already complete, finish cleanly.",
        description: "Automatically recover an interrupted provider stream",
        metadata: {
          shuv2code: { kind: "provider-stream-recovery", attempt: 1 },
        },
        delivery: "steer",
        resume: true,
      });
      NodeAssert.equal(events[0]?.type, "runtime.warning");
      NodeAssert.equal(events[1]?.type, "turn.completed");
      if (events[1]?.type === "turn.completed") {
        NodeAssert.equal(events[1].payload.state, "completed");
      }
      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("bounds missing-terminal recovery and leaves the reusable session ready", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing-terminal-recovery-limit");
      let releaseFailure: (() => void) | undefined;
      const promptAccepted = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      let recoveryCount = 0;
      const failed = {
        type: "session.execution.failed",
        data: {
          sessionID: "ses_missing_terminal_recovery_limit",
          error: {
            type: "provider.invalid-output",
            message: "Provider stream ended without a terminal finish event",
          },
        },
      } as const;
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await promptAccepted;
              yield failed;
              yield {
                type: "session.execution.started",
                data: { sessionID: "ses_missing_terminal_recovery_limit" },
              };
              yield failed;
              yield {
                type: "session.execution.started",
                data: { sessionID: "ses_missing_terminal_recovery_limit" },
              };
              yield failed;
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_missing_terminal_recovery_limit" }),
          switchModel: async () => undefined,
          prompt: async () => releaseFailure?.(),
          synthetic: async () => {
            recoveryCount += 1;
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" || event.type === "turn.completed"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "finish the work",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(recoveryCount, 2);
      NodeAssert.equal(events.filter((event) => event.type === "runtime.warning").length, 2);
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(completed.payload.state, "failed");
      }
      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("settles a resumed turn that is no longer active upstream", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resumed-idle");
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          get: async () => ({ id: "ses_resumed_idle" }),
          update: async () => ({ id: "ses_resumed_idle" }),
          messages: async () => ({ data: [], cursor: {} }),
          active: async () => ({}),
          wait: async () => undefined,
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "turn.completed" &&
            String(event.turnId) === "opencode2-turn-resumed-idle",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_resumed_idle",
          activeTurnId: "opencode2-turn-resumed-idle",
        },
      });

      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(session.status, "ready");
      NodeAssert.equal(session.activeTurnId, undefined);
      NodeAssert.deepEqual(session.resumeCursor, {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_resumed_idle",
      });
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("keeps a resumed turn active until the upstream wait completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resumed-running");
      let finishExecution: (() => void) | undefined;
      const executionFinished = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          get: async () => ({ id: "ses_resumed_running" }),
          update: async () => ({ id: "ses_resumed_running" }),
          messages: async () => ({ data: [], cursor: {} }),
          active: async () => ({ ses_resumed_running: { type: "running" } }),
          wait: async () => executionFinished,
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const completedEvent = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "turn.completed" &&
            String(event.turnId) === "opencode2-turn-resumed-running",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_resumed_running",
          activeTurnId: "opencode2-turn-resumed-running",
        },
      });

      NodeAssert.equal(session.status, "running");
      NodeAssert.equal(String(session.activeTurnId), "opencode2-turn-resumed-running");
      finishExecution?.();
      yield* Fiber.join(completedEvent).pipe(Effect.timeout("1 second"));
      const settledSession = (yield* adapter.listSessions())[0];
      NodeAssert.equal(settledSession?.status, "ready");
      NodeAssert.equal(settledSession?.activeTurnId, undefined);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter model selection", () => {
  it.effect("delivers shuv2code attachments through the native v2 prompt payload", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-v2-attachment");
      let promptBody: unknown;
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_v2_attachment" }),
          switchModel: async () => undefined,
          prompt: async (_sessionID: string, body: unknown) => {
            promptBody = body;
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "inspect this",
        attachments: [
          {
            type: "image",
            id: "thread-v2-attachment-12345678-1234-1234-1234-123456789abc",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [],
        },
      });

      NodeAssert.equal(
        (promptBody as { files?: ReadonlyArray<{ uri?: string }> }).files?.[0]?.uri?.startsWith(
          "file://",
        ),
        true,
      );
      NodeAssert.deepEqual(
        (promptBody as { text?: string; files?: ReadonlyArray<{ name?: string }> }).text,
        "inspect this",
      );
      NodeAssert.equal(
        (promptBody as { files?: ReadonlyArray<{ name?: string }> }).files?.[0]?.name,
        "image.png",
      );
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("switches the upstream session to the selected agent and model before prompting", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-selected-model");
      const calls: Array<readonly [string, unknown]> = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_selected_model" }),
          switchAgent: async (_sessionID: string, agent: string) => {
            calls.push(["agent", agent]);
          },
          switchModel: async (_sessionID: string, model: unknown) => {
            calls.push(["model", model]);
          },
          prompt: async (_sessionID: string, body: unknown) => {
            calls.push(["prompt", body]);
          },
        },
        form: { list: async () => [] },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use the selected model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencodeV2"),
          model: "openai/gpt-5.6-sol",
          options: [
            { id: "variant", value: "high" },
            { id: "agent", value: "build" },
          ],
        },
      });

      NodeAssert.deepEqual(calls, [
        ["agent", "build"],
        ["model", { providerID: "openai", id: "gpt-5.6-sol", variant: "high" }],
        ["prompt", { text: "use the selected model" }],
      ]);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter interruption", () => {
  it.effect("cancels pending forms and accepts a new turn after interruption", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-interrupt-form");
      const promptCalls: string[] = [];
      const cancelledForms: string[] = [];
      const client = {
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "server.connected" };
              await new Promise<never>(() => undefined);
            },
          }),
        },
        session: {
          create: async () => ({ id: "ses_interrupt_form" }),
          switchModel: async () => undefined,
          prompt: async (_sessionID: string, input: { readonly text: string }) => {
            promptCalls.push(input.text);
          },
          interrupt: async () => undefined,
        },
        form: {
          list: async () => [
            {
              id: "frm_interrupt_form",
              sessionID: "ses_interrupt_form",
              fields: [{ key: "q0", type: "string", title: "Question" }],
            },
          ],
          cancel: async (_sessionID: string, formID: string) => {
            cancelledForms.push(formID);
          },
        },
        permission: { list: async () => [] },
      } as unknown as OpenCodeV2Client;
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
      });
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencodeV2"),
        model: "openai/gpt-5.6-sol",
        options: [],
      };
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first",
        attachments: [],
        modelSelection,
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);

      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.deepEqual(cancelledForms, ["frm_interrupt_form"]);

      yield* adapter.sendTurn({
        threadId,
        input: "second",
        attachments: [],
        modelSelection,
      });
      NodeAssert.deepEqual(promptCalls, ["first", "second"]);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter adopted tool names", () => {
  it.effect("recovers a projected tool name before mapping a terminal event", () =>
    runAdoptedToolCompletion({
      messages: async (_sessionID?: string, options?: { readonly cursor?: string }) =>
        options?.cursor === "older-page"
          ? {
              data: [
                {
                  type: "assistant",
                  content: [{ type: "tool", id: "call_1", name: "bash" }],
                },
              ],
              cursor: {},
            }
          : { data: [], cursor: { next: "older-page" } },
      expectedTitle: "bash",
      expectedEventCount: 1,
    }),
  );

  it.effect("uses the generic tool name when projected messages are empty", () =>
    runAdoptedToolCompletion({
      messages: async () => ({ data: [], cursor: {} }),
      expectedTitle: "tool",
      expectedEventCount: 2,
    }),
  );

  it.effect("uses the generic tool name when projected-message recovery fails", () =>
    runAdoptedToolCompletion({
      messages: async () => {
        throw new Error("messages unavailable");
      },
      expectedTitle: "tool",
      expectedEventCount: 2,
    }),
  );
});

describe("OpenCodeV2Adapter tool lifecycle", () => {
  it.effect("maps the current ShuvCode callID field across a complete tool lifecycle", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-tool-call-id");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.tool.input.started",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              name: "bash",
            },
          },
          {
            type: "session.tool.called",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              input: { command: "pwd" },
            },
          },
          {
            type: "session.tool.success",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_1",
              content: [{ type: "text", text: "/workspace" }],
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type.startsWith("item.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => ({
          type: event.type,
          itemId: event.itemId,
          itemType: "itemType" in event.payload ? event.payload.itemType : undefined,
          status: "status" in event.payload ? event.payload.status : undefined,
          title: "title" in event.payload ? event.payload.title : undefined,
        })),
        [
          {
            type: "item.started",
            itemId: "call_1",
            itemType: "command_execution",
            status: "inProgress",
            title: "bash",
          },
          {
            type: "item.updated",
            itemId: "call_1",
            itemType: "command_execution",
            status: "inProgress",
            title: "bash",
          },
          {
            type: "item.completed",
            itemId: "call_1",
            itemType: "command_execution",
            status: "completed",
            title: "bash",
          },
        ],
      );
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("recovers tool input from the durable projection when V2 omits called events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-tool-input-recovery");
      let messageReads = 0;
      const client = makeAdoptionClient({
        messages: async () => {
          messageReads += 1;
          return messageReads === 1
            ? { data: [], cursor: {} }
            : {
                data: [
                  {
                    type: "assistant",
                    content: [
                      {
                        type: "tool",
                        id: "call_projection_only",
                        name: "shell",
                        state: {
                          input: { command: "rg -n thread_control_request apps/server" },
                        },
                      },
                    ],
                  },
                ],
                cursor: {},
              };
        },
        events: [
          {
            type: "session.tool.input.started",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_projection_only",
              name: "shell",
            },
          },
          {
            type: "session.tool.success",
            data: {
              sessionID: "ses_adopted",
              assistantMessageID: "msg_1",
              callID: "call_projection_only",
              content: [{ type: "text", text: "apps/server/src/mcp/tools.ts:1" }],
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_adopted",
        },
      });

      const [completed] = Array.from(
        yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type !== "item.completed") return;
      NodeAssert.deepEqual(completed.payload.data, {
        tool: "shell",
        input: { command: "rg -n thread_control_request apps/server" },
        sessionID: "ses_adopted",
        assistantMessageID: "msg_1",
        callID: "call_projection_only",
        content: [{ type: "text", text: "apps/server/src/mcp/tools.ts:1" }],
      });
      NodeAssert.equal(messageReads, 2);
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter reasoning lifecycle", () => {
  it.effect("keeps reasoning and assistant text distinct and completes plaintext reasoning", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-reasoning");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.reasoning.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.reasoning.delta",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              delta: "Inspect",
            },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Inspect adapter",
              state: { reasoningField: "reasoning_content" },
            },
          },
          {
            type: "session.text.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.text.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Done.",
            },
          },
          {
            type: "session.reasoning.started",
            data: { sessionID: "ses_reasoning", assistantMessageID: "msg_2", ordinal: 0 },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_reasoning",
              assistantMessageID: "msg_2",
              ordinal: 0,
              text: "Use the durable full-value boundary.",
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed"),
        ),
        Stream.take(10),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_reasoning",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => ({
          type: event.type,
          itemId: event.itemId,
          itemType: "itemType" in event.payload ? event.payload.itemType : undefined,
          streamKind: "streamKind" in event.payload ? event.payload.streamKind : undefined,
          delta: "delta" in event.payload ? event.payload.delta : undefined,
          detail: "detail" in event.payload ? event.payload.detail : undefined,
        })),
        [
          {
            type: "item.started",
            itemId: "msg_1:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: "Inspect",
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: " adapter",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_1:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: "Inspect adapter",
          },
          {
            type: "item.started",
            itemId: "msg_1:assistant_text:0",
            itemType: "assistant_message",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_1:assistant_text:0",
            itemType: undefined,
            streamKind: "assistant_text",
            delta: "Done.",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_1:assistant_text:0",
            itemType: "assistant_message",
            streamKind: undefined,
            delta: undefined,
            detail: "Done.",
          },
          {
            type: "item.started",
            itemId: "msg_2:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: undefined,
          },
          {
            type: "content.delta",
            itemId: "msg_2:reasoning_text:0",
            itemType: undefined,
            streamKind: "reasoning_text",
            delta: "Use the durable full-value boundary.",
            detail: undefined,
          },
          {
            type: "item.completed",
            itemId: "msg_2:reasoning_text:0",
            itemType: "reasoning",
            streamKind: undefined,
            delta: undefined,
            detail: "Use the durable full-value boundary.",
          },
        ],
      );
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );

  it.effect("drops empty encrypted-only reasoning completions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-encrypted-reasoning");
      const client = makeAdoptionClient({
        messages: async () => ({ data: [], cursor: {} }),
        events: [
          {
            type: "session.reasoning.started",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              state: { reasoningEncryptedContent: "ciphertext" },
            },
          },
          {
            type: "session.reasoning.ended",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "",
              state: { reasoningEncryptedContent: "ciphertext" },
            },
          },
          {
            type: "session.text.started",
            data: { sessionID: "ses_encrypted", assistantMessageID: "msg_1", ordinal: 0 },
          },
          {
            type: "session.text.ended",
            data: {
              sessionID: "ses_encrypted",
              assistantMessageID: "msg_1",
              ordinal: 0,
              text: "Done.",
            },
          },
        ],
      });
      const adapter = yield* makeOpenCodeV2Adapter(OPEN_CODE_V2_SETTINGS, {
        clientFactory: () => client,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "item.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencodeV2"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          kind: "opencode-v2",
          schemaVersion: 1,
          sessionId: "ses_encrypted",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      NodeAssert.equal(events[0]?.type, "item.completed");
      if (events[0]?.type === "item.completed") {
        NodeAssert.equal(events[0].payload.itemType, "assistant_message");
      }
    }).pipe(Effect.provide(OpenCodeV2AdapterTestLayer)),
  );
});

describe("OpenCodeV2Adapter form mapping", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_live",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Scope",
        description: "What scope?",
        options: [{ value: "small", label: "Small", description: "Small change" }],
      },
      {
        key: "q1",
        type: "multiselect",
        title: "Areas",
        options: [
          { value: "server", label: "Server" },
          { value: "web", label: "Web" },
        ],
      },
      { key: "ignored", type: "boolean", title: "Unsupported" },
    ],
  } as const;

  it("finds a nested form session id in live SSE envelopes", () => {
    NodeAssert.equal(
      openCodeV2EventSessionId({
        type: "form.created",
        data: { form: { id: "frm_1", sessionID: "ses_live", fields: [] } },
      }),
      "ses_live",
    );
  });

  it("uses stable field keys and preserves custom-only string questions", () => {
    NodeAssert.deepEqual(mapOpenCodeV2FormToQuestions(form), [
      {
        id: "q0",
        header: "Scope",
        question: "What scope?",
        options: [{ label: "Small", description: "Small change" }],
        multiSelect: false,
      },
      {
        id: "q1",
        header: "Areas",
        question: "Areas",
        options: [
          { label: "Server", description: "Server" },
          { label: "Web", description: "Web" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("submits mapped fields only", () => {
    NodeAssert.deepEqual(
      toOpenCodeV2FormAnswer(form, {
        q0: "custom scope",
        q1: ["Server", "Web"],
        stale: "do not submit",
      }),
      {
        q0: "custom scope",
        q1: ["server", "web"],
      },
    );
  });

  it("maps scalar labels and missing option values while preserving custom text", () => {
    NodeAssert.deepEqual(
      toOpenCodeV2FormAnswer(
        {
          ...form,
          fields: [
            ...form.fields,
            {
              key: "q2",
              type: "string",
              options: [{ label: "Keep label" }],
            },
          ],
        },
        {
          q0: "Small",
          q1: ["Server", "custom area"],
          q2: "Keep label",
        },
      ),
      {
        q0: "small",
        q1: ["server", "custom area"],
        q2: "Keep label",
      },
    );
  });
});

describe("OpenCodeV2Adapter command payload decoding", () => {
  it.effect("decodes valid form, permission, and resume payloads", () =>
    Effect.gen(function* () {
      const decodedForm = yield* decodeOpenCodeV2Form({
        id: " frm_1 ",
        sessionID: " ses_live ",
        fields: [{ key: " scope ", options: [{ label: "Small", value: "small" }] }],
      });
      const decodedPermission = yield* decodeOpenCodeV2Permission({
        id: " perm_1 ",
        action: "bash",
        resources: ["pwd"],
      });
      const decodedResume = yield* decodeOpenCodeV2ResumeCursor({
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: " ses_live ",
      });

      NodeAssert.equal(decodedForm.id, "frm_1");
      NodeAssert.equal(decodedForm.fields?.[0]?.key, "scope");
      NodeAssert.equal(decodedPermission.id, "perm_1");
      NodeAssert.equal(decodedResume.sessionId, "ses_live");
    }),
  );

  it.effect("rejects missing or invalid command-critical identifiers and replies", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.all([
        Effect.exit(decodeOpenCodeV2Form({ sessionID: "ses_live" })),
        Effect.exit(decodeOpenCodeV2Permission({ action: "bash" })),
        Effect.exit(decodeOpenCodeV2PermissionReply({ requestID: "", reply: "once" })),
        Effect.exit(
          decodeOpenCodeV2ResumeCursor({
            kind: "opencode-v2",
            schemaVersion: 1,
            sessionId: " ",
          }),
        ),
      ]);

      for (const exit of exits) {
        NodeAssert.equal(exit._tag, "Failure");
      }
    }),
  );
});
