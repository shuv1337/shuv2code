import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";
import { BotExecutionBinding, BotExecutionBindingId, BotId } from "@shuv2code/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  ADE_CODEX_SERVICE_NAME,
  AdeCodexKernelAdapter,
  adeCodexThreadSource,
  buildAdeCodexInitializeParams,
  makeAdeCodexKernelConnection,
  toBotExecutionBinding,
  type AdeCodexKernelConnection,
  type AdeCodexThreadEvent,
  type AdeCodexToolInvocation,
} from "./AdeCodexKernelAdapter.ts";
import { layerTest as supervisorLayerTest } from "../provider/Layers/CodexAppServerSupervisor.ts";

const BOT_ID = BotId.make("bot-coder-1");

interface RecordedRequest {
  readonly lane: "typed" | "raw";
  readonly method: string;
  readonly payload: unknown;
}

type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;

/**
 * Fake shared-supervisor client: records outgoing requests, answers them from
 * a per-method response table, and lets tests fire server→client requests and
 * notifications through the handlers the adapter registered.
 */
const makeFakeCodexClient = (overrides: Record<string, (payload: unknown) => unknown> = {}) => {
  const requests: Array<RecordedRequest> = [];
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();

  const defaultResponse = (method: string, payload: unknown): unknown => {
    const override = overrides[method];
    if (override) return override(payload);
    switch (method) {
      case "initialize":
        return { userAgent: "fake-shared-app-server" };
      case "thread/start":
        return { thread: { id: "codex-thread-1" }, extraneous: "ignored" };
      case "thread/resume":
        return { thread: { id: (payload as { threadId: string }).threadId } };
      case "thread/fork":
        return { thread: { id: "codex-thread-fork-1" } };
      case "turn/steer":
        return { turnId: "turn-steered-1" };
      case "turn/start":
        return { turn: { id: "turn-1" } };
      default:
        return {};
    }
  };

  const client = {
    raw: {
      request: (method: string, payload: unknown) => {
        requests.push({ lane: "raw", method, payload });
        return Effect.succeed(defaultResponse(method, payload));
      },
    },
    request: (method: string, payload: unknown) => {
      requests.push({ lane: "typed", method, payload });
      return Effect.succeed(defaultResponse(method, payload));
    },
    notify: () => Effect.void,
    handleServerRequest: (method: string, handler: ServerRequestHandler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler);
      }),
    handleServerNotification: (method: string, handler: ServerNotificationHandler) =>
      Effect.sync(() => {
        const current = notificationHandlers.get(method) ?? [];
        current.push(handler);
        notificationHandlers.set(method, current);
      }),
    handleUnknownServerRequest: () => Effect.void,
    handleUnknownServerNotification: () => Effect.void,
  } as unknown as CodexClient.CodexAppServerClient["Service"];

  const fireServerRequest = (
    method: string,
    payload: unknown,
  ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> => {
    const handler = requestHandlers.get(method);
    if (!handler) {
      return Effect.die(new Error(`no handler registered for ${method}`));
    }
    return handler(payload);
  };

  const fireServerNotification = (method: string, payload: unknown): Effect.Effect<void> =>
    Effect.forEach(notificationHandlers.get(method) ?? [], (handler) =>
      handler(payload).pipe(Effect.catch(() => Effect.void)),
    ).pipe(Effect.asVoid);

  return { client, requests, fireServerRequest, fireServerNotification };
};

const makeConnection = (harness: ReturnType<typeof makeFakeCodexClient>) =>
  Effect.gen(function* () {
    const terminated = yield* Deferred.make<CodexErrors.CodexAppServerError>();
    const connection = yield* makeAdeCodexKernelConnection({
      client: harness.client,
      terminated: Deferred.await(terminated),
    });
    return connection;
  });

const startDefaultThread = (
  connection: AdeCodexKernelConnection,
  onToolCall: (
    invocation: AdeCodexToolInvocation,
  ) => Effect.Effect<
    { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean },
    CodexErrors.CodexAppServerError
  > = () =>
    Effect.succeed({
      contentItems: [{ type: "inputText" as const, text: "ok" }],
      success: true,
    }),
) =>
  connection.startThread({
    botId: BOT_ID,
    purpose: "specialized-work",
    cwd: "/tmp/project",
    dynamicTools: [
      {
        type: "function",
        name: "ade_report_result",
        description: "Report a structured assignment result to ADE.",
        inputSchema: { type: "object", properties: { summary: { type: "string" } } },
      },
    ],
    onToolCall,
  });

describe("AdeCodexKernelAdapter connection", () => {
  it.effect("initializes with ADE clientInfo tagging", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      yield* makeConnection(harness);

      const initialize = harness.requests.find((request) => request.method === "initialize");
      NodeAssert.ok(initialize);
      const params = initialize.payload as ReturnType<typeof buildAdeCodexInitializeParams>;
      NodeAssert.equal(params.clientInfo.name, "shuv2code_ade");
      NodeAssert.equal(params.capabilities?.experimentalApi, true);
    }),
  );

  it.effect("starts a thread with dynamicTools, serviceName and threadSource on the raw lane", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      NodeAssert.equal(session.threadId, "codex-thread-1");
      const start = harness.requests.find((request) => request.method === "thread/start");
      NodeAssert.ok(start);
      NodeAssert.equal(start.lane, "raw");
      const payload = start.payload as Record<string, unknown>;
      NodeAssert.equal(payload.serviceName, ADE_CODEX_SERVICE_NAME);
      NodeAssert.equal(payload.threadSource, adeCodexThreadSource(BOT_ID, "specialized-work"));
      NodeAssert.deepStrictEqual(payload.dynamicTools, [
        {
          type: "function",
          name: "ade_report_result",
          description: "Report a structured assignment result to ADE.",
          inputSchema: { type: "object", properties: { summary: { type: "string" } } },
        },
      ]);

      NodeAssert.deepStrictEqual(session.binding, {
        botId: BOT_ID,
        engine: "codex",
        sessionId: "codex-thread-1",
        purpose: "specialized-work",
        threadSource: adeCodexThreadSource(BOT_ID, "specialized-work"),
      });
    }),
  );

  it.effect("dispatches item/tool/call to the registered session handler", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const invocations: Array<AdeCodexToolInvocation> = [];
      yield* startDefaultThread(connection, (invocation) => {
        invocations.push(invocation);
        return Effect.succeed({
          contentItems: [{ type: "inputText" as const, text: "handled" }],
          success: true,
        });
      });

      const response = yield* harness.fireServerRequest("item/tool/call", {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "ade_report_result",
        arguments: { summary: "done" },
      });

      NodeAssert.deepStrictEqual(response, {
        contentItems: [{ type: "inputText", text: "handled" }],
        success: true,
      });
      NodeAssert.equal(invocations.length, 1);
      NodeAssert.equal(invocations[0]?.tool, "ade_report_result");
      NodeAssert.deepStrictEqual(invocations[0]?.arguments, { summary: "done" });
    }),
  );

  it.effect("restores tool registration on resume without resending dynamicTools", () =>
    Effect.gen(function* () {
      // First lifetime: start the thread with dynamicTools.
      const firstHarness = makeFakeCodexClient();
      const firstConnection = yield* makeConnection(firstHarness);
      const started = yield* startDefaultThread(firstConnection);

      // Second lifetime (fresh connection after a restart): resume by the
      // recorded kernel session id.
      const secondHarness = makeFakeCodexClient();
      const secondConnection = yield* makeConnection(secondHarness);
      const restoredInvocations: Array<AdeCodexToolInvocation> = [];
      const resumed = yield* secondConnection.resumeThread({
        threadId: started.threadId,
        botId: BOT_ID,
        purpose: "specialized-work",
        cwd: "/tmp/project",
        onToolCall: (invocation) => {
          restoredInvocations.push(invocation);
          return Effect.succeed({
            contentItems: [{ type: "inputText" as const, text: "restored" }],
            success: true,
          });
        },
      });

      NodeAssert.equal(resumed.threadId, "codex-thread-1");
      const resume = secondHarness.requests.find((request) => request.method === "thread/resume");
      NodeAssert.ok(resume);
      NodeAssert.equal(resume.lane, "typed");
      const payload = resume.payload as Record<string, unknown>;
      NodeAssert.equal(payload.threadId, "codex-thread-1");
      // Codex restores persisted dynamicTools from the rollout; the adapter
      // must not (and cannot) resend them on thread/resume.
      NodeAssert.ok(!("dynamicTools" in payload));

      // Restored registration: invocations for the resumed thread dispatch to
      // the freshly supplied handler.
      const response = yield* secondHarness.fireServerRequest("item/tool/call", {
        threadId: "codex-thread-1",
        turnId: "turn-2",
        callId: "call-2",
        tool: "ade_report_result",
        arguments: {},
      });
      NodeAssert.deepStrictEqual(response, {
        contentItems: [{ type: "inputText", text: "restored" }],
        success: true,
      });
      NodeAssert.equal(restoredInvocations.length, 1);
    }),
  );

  it.effect("injects items into model-visible history via thread/inject_items", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      const resultItem = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Assignment a-1 completed: shipped." }],
      };
      yield* session.injectItems([resultItem]);

      const inject = harness.requests.find((request) => request.method === "thread/inject_items");
      NodeAssert.ok(inject);
      NodeAssert.equal(inject.lane, "typed");
      NodeAssert.deepStrictEqual(inject.payload, {
        threadId: "codex-thread-1",
        items: [resultItem],
      });
    }),
  );

  it.effect("keeps turn/steer and turn/interrupt distinct operations", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      const steered = yield* session.steerTurn({
        expectedTurnId: "turn-active-1",
        text: "Focus on the failing test first.",
        clientUserMessageId: "steer-msg-1",
      });
      NodeAssert.equal(steered.turnId, "turn-steered-1");

      yield* session.interruptTurn("turn-active-1");

      const methods = harness.requests
        .filter((request) => request.method.startsWith("turn/"))
        .map((request) => request.method);
      NodeAssert.deepStrictEqual(methods, ["turn/steer", "turn/interrupt"]);

      const steer = harness.requests.find((request) => request.method === "turn/steer");
      NodeAssert.deepStrictEqual(steer?.payload, {
        threadId: "codex-thread-1",
        expectedTurnId: "turn-active-1",
        input: [{ type: "text", text: "Focus on the failing test first." }],
        clientUserMessageId: "steer-msg-1",
      });
      const interrupt = harness.requests.find((request) => request.method === "turn/interrupt");
      NodeAssert.deepStrictEqual(interrupt?.payload, {
        threadId: "codex-thread-1",
        turnId: "turn-active-1",
      });
    }),
  );

  it.effect("surfaces approval requests as respondable events (Needs You seam)", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      const approvalFiber = yield* harness
        .fireServerRequest("item/commandExecution/requestApproval", {
          threadId: "codex-thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: "rm -rf build",
          startedAtMs: 1,
        })
        .pipe(Effect.forkChild);

      const [event] = yield* session.events.pipe(Stream.take(1), Stream.runCollect);
      NodeAssert.ok(event);
      NodeAssert.equal(event._tag, "approvalRequested");
      if (event._tag !== "approvalRequested") return;
      NodeAssert.equal(event.request.method, "item/commandExecution/requestApproval");
      NodeAssert.equal(event.request.threadId, "codex-thread-1");
      if (event.request.method !== "item/commandExecution/requestApproval") return;
      NodeAssert.equal(event.request.params.command, "rm -rf build");

      yield* event.request.respond({ decision: "accept" });
      const decided = yield* Fiber.join(approvalFiber);
      NodeAssert.deepStrictEqual(decided, { decision: "accept" });
    }),
  );

  it.effect("surfaces MCP elicitation requests on the same event seam", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      const elicitationFiber = yield* harness
        .fireServerRequest("mcpServer/elicitation/request", {
          threadId: "codex-thread-1",
          turnId: "turn-1",
          mode: "openai/form",
          message: "Pick a deployment target",
          requestedSchema: { type: "object" },
          serverName: "deploy",
        })
        .pipe(Effect.forkChild);

      const [event] = yield* session.events.pipe(Stream.take(1), Stream.runCollect);
      NodeAssert.ok(event);
      NodeAssert.equal(event._tag, "approvalRequested");
      if (event._tag !== "approvalRequested") return;
      NodeAssert.equal(event.request.method, "mcpServer/elicitation/request");
      if (event.request.method !== "mcpServer/elicitation/request") return;

      yield* event.request.respond({ action: "decline" });
      const decided = yield* Fiber.join(elicitationFiber);
      NodeAssert.deepStrictEqual(decided, { action: "decline" });
    }),
  );

  it.effect("delivers thread/status/changed only to the owning session", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      // Foreign-thread traffic (e.g. a realtime voice thread on another
      // connection would never even arrive here) is dropped, not surfaced.
      yield* harness.fireServerNotification("thread/status/changed", {
        threadId: "codex-thread-foreign",
        status: { state: "idle", activeFlags: [] },
      });
      yield* harness.fireServerNotification("thread/status/changed", {
        threadId: "codex-thread-1",
        status: { state: "idle", activeFlags: [] },
      });

      const events: Array<AdeCodexThreadEvent> = Array.from(
        yield* session.events.pipe(Stream.take(1), Stream.runCollect),
      );
      NodeAssert.deepStrictEqual(events, [
        {
          _tag: "statusChanged",
          threadId: "codex-thread-1",
          status: { state: "idle", activeFlags: [] },
        },
      ]);
    }),
  );

  it.effect("fails tool calls for unregistered threads instead of guessing", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      yield* startDefaultThread(connection);

      const error = yield* harness
        .fireServerRequest("item/tool/call", {
          threadId: "codex-thread-foreign",
          turnId: "turn-1",
          callId: "call-1",
          tool: "ade_report_result",
          arguments: {},
        })
        .pipe(Effect.asVoid, Effect.flip);

      NodeAssert.equal(error._tag, "CodexAppServerRequestError");
    }),
  );

  it.effect("records fork lineage and routes child tool calls to the child handler", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connection = yield* makeConnection(harness);
      const session = yield* startDefaultThread(connection);

      const childInvocations: Array<AdeCodexToolInvocation> = [];
      const child = yield* session.fork({
        purpose: "parallel-work",
        onToolCall: (invocation) => {
          childInvocations.push(invocation);
          return Effect.succeed({
            contentItems: [{ type: "inputText" as const, text: "child" }],
            success: true,
          });
        },
      });

      const fork = harness.requests.find((request) => request.method === "thread/fork");
      NodeAssert.ok(fork);
      NodeAssert.deepStrictEqual(fork.payload, {
        threadId: "codex-thread-1",
        threadSource: adeCodexThreadSource(BOT_ID, "parallel-work"),
      });
      NodeAssert.deepStrictEqual(child.binding, {
        botId: BOT_ID,
        engine: "codex",
        sessionId: "codex-thread-fork-1",
        purpose: "parallel-work",
        threadSource: adeCodexThreadSource(BOT_ID, "parallel-work"),
        forkedFromThreadId: "codex-thread-1",
      });

      yield* harness.fireServerRequest("item/tool/call", {
        threadId: "codex-thread-fork-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "ade_report_result",
        arguments: {},
      });
      NodeAssert.equal(childInvocations.length, 1);
    }),
  );

  it.effect("session scope close drops the thread registration", () =>
    Effect.gen(function* () {
      const harness = makeFakeCodexClient();
      const connectionScope = yield* Scope.make();
      const sessionScope = yield* Scope.make();
      const connection = yield* makeConnection(harness).pipe(
        Effect.provideService(Scope.Scope, connectionScope),
      );
      yield* startDefaultThread(connection).pipe(Effect.provideService(Scope.Scope, sessionScope));

      yield* Scope.close(sessionScope, Exit.void);
      const error = yield* harness
        .fireServerRequest("item/tool/call", {
          threadId: "codex-thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "ade_report_result",
          arguments: {},
        })
        .pipe(Effect.asVoid, Effect.flip);
      NodeAssert.equal(error._tag, "CodexAppServerRequestError");

      yield* Scope.close(connectionScope, Exit.void);
    }),
  );
});

const decodeKernelSessionId = Schema.decodeUnknownSync(BotExecutionBinding.fields.sessionId);
const decodeBindingTimestamp = Schema.decodeUnknownSync(BotExecutionBinding.fields.createdAt);
const decodeBotExecutionBinding = Schema.decodeUnknownSync(BotExecutionBinding);

describe("toBotExecutionBinding", () => {
  it("maps a session descriptor to a schema-valid BotExecutionBinding record", () => {
    const binding = toBotExecutionBinding(
      {
        botId: BOT_ID,
        engine: "codex",
        sessionId: decodeKernelSessionId("codex-thread-1"),
        purpose: "specialized-work",
        threadSource: adeCodexThreadSource(BOT_ID, "specialized-work"),
        forkedFromThreadId: "codex-thread-0",
      },
      {
        id: BotExecutionBindingId.make("binding-1"),
        now: decodeBindingTimestamp("2026-08-24T00:00:00.000Z"),
      },
    );

    const decoded = decodeBotExecutionBinding(binding);
    NodeAssert.equal(decoded.engine, "codex");
    NodeAssert.equal(decoded.sessionId, "codex-thread-1");
    NodeAssert.equal(decoded.purpose, "specialized-work");
    NodeAssert.equal(decoded.status, "active");
  });
});

describe("AdeCodexKernelAdapter layer", () => {
  it.effect("fails closed when the supervisor cannot issue shared connections", () =>
    Effect.gen(function* () {
      const adapter = yield* AdeCodexKernelAdapter;
      const error = yield* adapter
        .connect({
          binaryPath: "codex",
          codexHome: "",
          launchArgs: "",
          cwd: "/tmp/project",
          runtimeDir: "/tmp/runtime",
        })
        .pipe(Effect.asVoid, Effect.flip);

      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
    }).pipe(Effect.provide(AdeCodexKernelAdapter.layer.pipe(Layer.provide(supervisorLayerTest())))),
  );
});
