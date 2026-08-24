import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderDriverKind, ThreadId } from "@shuv2code/contracts";
import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { startOpenCodeV2Mock } from "../opencodeV2Mock.testSupport.ts";
import type { ProviderDynamicToolSignal } from "../Services/ProviderDynamicTools.ts";

import { makeOpenCodeV2Adapter } from "./OpenCodeV2Adapter.ts";

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("not used"),
  connectToOpenCodeServer: () => Effect.die("not used"),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () => Effect.die("not used"),
  loadInventoryFromCli: () => Effect.die("not used"),
};

const TestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const ADE_TOOLS = [
  {
    name: "fleet_read",
    description: "Read the fleet snapshot.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "steer_primary",
    description: "Steer the primary session.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
] as const;

const ADE_METADATA = { "shuv2code/ade": { botId: "bot_firstmate", bindingId: "bind_1" } } as const;

const makeMockedAdapter = Effect.gen(function* () {
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() => startOpenCodeV2Mock()),
    (started) => Effect.promise(() => started.close()),
  );
  const adapter = yield* makeOpenCodeV2Adapter(
    {
      enabled: true,
      binaryPath: "opencode",
      serverUrl: mock.baseUrl,
      serverPassword: "",
      customModels: [],
    },
    {},
  ).pipe(
    Effect.provideService(OpenCodeRuntime, {
      ...OpenCodeRuntimeTestDouble,
      connectToOpenCodeServer: () =>
        Effect.succeed({
          url: mock.baseUrl,
          exitCode: null,
          external: true,
          protocol: "v2" as const,
        }),
    }),
  );
  const seam = adapter.dynamicTools;
  NodeAssert.ok(seam, "OpenCodeV2 adapter must expose the dynamic tool seam");
  const startThread = (threadId: ThreadId, resumeCursor?: unknown) =>
    adapter.startSession({
      provider: ProviderDriverKind.make("opencodeV2"),
      threadId,
      runtimeMode: "full-access",
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
    });
  const takeSignal = seam.takeSignal.pipe(Effect.timeout("2 seconds"));
  return { mock, adapter, seam, startThread, takeSignal };
});

function expectRequested(signal: ProviderDynamicToolSignal) {
  NodeAssert.equal(signal.kind, "requested");
  if (signal.kind !== "requested") throw new Error("unreachable");
  return signal.call;
}

describe("OpenCodeV2Adapter dynamic tools", () => {
  it.effect("registers configured tools and metadata at session create", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-create");
      yield* seam.configureThread({ threadId, tools: ADE_TOOLS, metadata: ADE_METADATA });

      const session = yield* startThread(threadId);

      const create = mock.requests.find(
        (request) => request.method === "POST" && request.path === "/api/session",
      );
      NodeAssert.ok(create);
      const body = create.body as {
        readonly tools?: unknown;
        readonly metadata?: unknown;
      };
      NodeAssert.deepEqual(body.tools, ADE_TOOLS);
      NodeAssert.deepEqual(body.metadata, ADE_METADATA);
      NodeAssert.deepEqual(mock.sessionTools.get(session.providerThreadId ?? ""), ADE_TOOLS);
      NodeAssert.deepEqual(
        mock.sessions.get(session.providerThreadId ?? "")?.metadata,
        ADE_METADATA,
      );
      NodeAssert.deepEqual(Array.from(yield* seam.listTools(threadId)), ADE_TOOLS);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates undecorated sessions without tools or metadata", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-undecorated");

      const session = yield* startThread(threadId);

      const create = mock.requests.find(
        (request) => request.method === "POST" && request.path === "/api/session",
      );
      NodeAssert.ok(create);
      const body = create.body as Record<string, unknown>;
      NodeAssert.equal("tools" in body, false);
      NodeAssert.equal("metadata" in body, false);
      NodeAssert.equal(mock.sessionTools.has(session.providerThreadId ?? ""), false);
      NodeAssert.deepEqual(Array.from(yield* seam.listTools(threadId)), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects invalid tool catalogs before any provider call", () =>
    Effect.gen(function* () {
      const { mock, seam } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-invalid");
      const invalidCatalogs = [
        [{ name: "9starts-with-digit", description: "bad" }],
        [{ name: "execute", description: "reserved" }],
        [
          { name: "fleet_read", description: "one" },
          { name: "fleet_read", description: "two" },
        ],
        [{ name: "x".repeat(65), description: "too long" }],
      ];
      for (const tools of invalidCatalogs) {
        const failure = yield* Effect.flip(seam.configureThread({ threadId, tools }));
        NodeAssert.equal(failure._tag, "ProviderAdapterValidationError");
      }
      NodeAssert.deepEqual(mock.requests, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("dispatches invocations to the seam and settles replies", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-dispatch");
      yield* seam.configureThread({ threadId, tools: ADE_TOOLS });
      const session = yield* startThread(threadId);
      const sessionId = session.providerThreadId ?? "";

      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_1",
        tool: "steer_primary",
        input: { text: "focus on the failing test" },
      });
      const call = expectRequested(yield* takeSignal);
      NodeAssert.equal(call.threadId, threadId);
      NodeAssert.equal(call.callId, "call_dyn_1");
      NodeAssert.equal(call.tool, "steer_primary");
      NodeAssert.deepEqual(call.input, { text: "focus on the failing test" });

      const pendingBefore = yield* seam.pendingCalls(threadId);
      NodeAssert.deepEqual(
        pendingBefore.map((pending) => pending.callId),
        ["call_dyn_1"],
      );
      yield* seam.replyToCall({
        threadId,
        callId: "call_dyn_1",
        result: { status: "completed", content: "steered" },
      });
      NodeAssert.deepEqual(mock.toolReplies, [
        {
          sessionID: sessionId,
          callID: "call_dyn_1",
          reply: { status: "completed", content: "steered" },
        },
      ]);
      NodeAssert.deepEqual(Array.from(yield* seam.pendingCalls(threadId)), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("surfaces a settled-call reply as a readable 409 conflict", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-conflict");
      yield* seam.configureThread({ threadId, tools: ADE_TOOLS });
      const session = yield* startThread(threadId);
      const sessionId = session.providerThreadId ?? "";
      mock.triggerDynamicToolCall(sessionId, { callID: "call_dyn_c", tool: "fleet_read" });
      yield* seam.replyToCall({
        threadId,
        callId: "call_dyn_c",
        result: { status: "completed", content: "done" },
      });

      const conflict = yield* Effect.flip(
        seam.replyToCall({
          threadId,
          callId: "call_dyn_c",
          result: { status: "failed", message: "already settled" },
        }),
      );
      NodeAssert.equal(conflict._tag, "ProviderAdapterRequestError");
      if (conflict._tag !== "ProviderAdapterRequestError") return;
      NodeAssert.equal(conflict.status, 409);
      NodeAssert.match(conflict.detail, /409/);
      NodeAssert.match(conflict.detail, /ConflictError/);
      NodeAssert.doesNotMatch(conflict.detail, /\[object Object\]/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("re-attach replaces the tool set and drains buffered pending calls losslessly", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-reattach");
      const sessionId = "ses_preexisting";
      mock.sessions.set(sessionId, { id: sessionId });
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_offline_1",
        tool: "fleet_read",
        input: {},
      });
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_offline_2",
        tool: "steer_primary",
        input: { text: "resume" },
      });

      yield* seam.configureThread({ threadId, tools: ADE_TOOLS, metadata: ADE_METADATA });
      yield* startThread(threadId, {
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId,
      });

      const replaceSet = mock.requests.find(
        (request) => request.method === "PUT" && request.path === `/api/session/${sessionId}/tools`,
      );
      NodeAssert.ok(replaceSet, "re-attach must replace-set the configured tool catalog");
      NodeAssert.deepEqual(mock.sessionTools.get(sessionId), ADE_TOOLS);

      // Both buffered calls arrive in order even though the consumer attaches
      // late, and each exactly once despite the queued SSE replay of the same
      // dispatches racing the drain.
      const first = expectRequested(yield* takeSignal);
      const second = expectRequested(yield* takeSignal);
      NodeAssert.deepEqual(
        [first.callId, second.callId],
        ["call_dyn_offline_1", "call_dyn_offline_2"],
      );
      NodeAssert.equal(first.threadId, threadId);

      // The next signal is a freshly triggered call, not a duplicate replay.
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_after_reattach",
        tool: "steer_primary",
        input: { text: "next" },
      });
      const next = expectRequested(yield* takeSignal);
      NodeAssert.equal(next.callId, "call_dyn_after_reattach");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("drains pending calls on re-attach even without a configured catalog", () =>
    Effect.gen(function* () {
      const { mock, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-unconfigured-drain");
      const sessionId = "ses_unconfigured";
      mock.sessions.set(sessionId, { id: sessionId });
      mock.sessionTools.set(sessionId, ADE_TOOLS);
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_stranded",
        tool: "fleet_read",
        input: {},
      });

      yield* startThread(threadId, { kind: "opencode-v2", schemaVersion: 1, sessionId });

      const call = expectRequested(yield* takeSignal);
      NodeAssert.equal(call.callId, "call_dyn_stranded");
      NodeAssert.equal(call.threadId, threadId);
      const replaceSet = mock.requests.find(
        (request) => request.method === "PUT" && request.path === `/api/session/${sessionId}/tools`,
      );
      NodeAssert.equal(replaceSet, undefined, "unconfigured re-attach must not replace-set tools");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("configureThread on a live session replace-sets and drains pending calls", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-live-configure");
      const session = yield* startThread(threadId);
      const sessionId = session.providerThreadId ?? "";
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_preconfig",
        tool: "fleet_read",
        input: {},
      });

      yield* seam.configureThread({ threadId, tools: ADE_TOOLS });

      NodeAssert.deepEqual(mock.sessionTools.get(sessionId), ADE_TOOLS);
      const call = expectRequested(yield* takeSignal);
      NodeAssert.equal(call.callId, "call_dyn_preconfig");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("synthesizes cancelled signals for outstanding calls on stopSession", () =>
    Effect.gen(function* () {
      const { mock, seam, adapter, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-stop");
      yield* seam.configureThread({ threadId, tools: ADE_TOOLS });
      const session = yield* startThread(threadId);
      const sessionId = session.providerThreadId ?? "";
      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_orphaned",
        tool: "fleet_read",
        input: {},
      });
      const call = expectRequested(yield* takeSignal);
      NodeAssert.equal(call.callId, "call_dyn_orphaned");

      yield* adapter.stopSession(threadId);

      const cancelled = yield* takeSignal;
      NodeAssert.deepEqual(cancelled, {
        kind: "cancelled",
        threadId,
        callId: "call_dyn_orphaned",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("surfaces provider-side cancellation on the seam", () =>
    Effect.gen(function* () {
      const { mock, seam, startThread, takeSignal } = yield* makeMockedAdapter;
      const threadId = ThreadId.make("thread-dyn-cancel");
      yield* seam.configureThread({ threadId, tools: ADE_TOOLS });
      const session = yield* startThread(threadId);
      const sessionId = session.providerThreadId ?? "";

      mock.triggerDynamicToolCall(sessionId, {
        callID: "call_dyn_cancel",
        tool: "fleet_read",
        input: {},
      });
      mock.cancelDynamicToolCall(sessionId, "call_dyn_cancel");

      const requested = expectRequested(yield* takeSignal);
      NodeAssert.equal(requested.callId, "call_dyn_cancel");
      const cancelled = yield* takeSignal;
      NodeAssert.deepEqual(cancelled, {
        kind: "cancelled",
        threadId,
        callId: "call_dyn_cancel",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
