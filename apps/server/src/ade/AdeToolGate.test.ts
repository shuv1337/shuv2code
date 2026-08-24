import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { describe } from "vite-plus/test";

import { BotId, KernelSessionId, ThreadId } from "@shuv2code/contracts";

import type { AdeCodexToolInvocation } from "./AdeCodexKernelAdapter.ts";
import {
  ADE_APPROVAL_NAME_PATTERN,
  ADE_BASE_TOOL_NAMES,
  AdeToolGate,
  AdeToolExecutionError,
  adeToolHandlersUnavailable,
  makeAdeToolGate,
  renderAdeToolDenial,
  type AdeScreenboxToolPlaneShape,
  type AdeToolCallContext,
  type AdeToolHandlersShape,
  type AdeToolInlineChecksShape,
  type AdeToolOutcome,
  type AdeToolSessionPrincipal,
} from "./AdeToolGate.ts";
import type {
  ProviderDynamicToolCall,
  ProviderDynamicToolResult,
  ProviderDynamicToolSignal,
  ProviderDynamicToolThreadConfig,
  ProviderDynamicToolsShape,
} from "../provider/Services/ProviderDynamicTools.ts";

const BOT_A = BotId.make("bot-alpha");
const BOT_B = BotId.make("bot-beta");

const principalA: AdeToolSessionPrincipal = { botId: BOT_A, purpose: "primary-text" };
const principalB: AdeToolSessionPrincipal = { botId: BOT_B, purpose: "parallel-work" };

const ctxFor = (
  principal: AdeToolSessionPrincipal,
  tool: string,
  session = "session-1",
): AdeToolCallContext => ({
  ...principal,
  engine: "shuvcode",
  sessionId: KernelSessionId.make(session),
  tool,
});

const allowAllChecks: AdeToolInlineChecksShape = {
  isRoutingTargetAllowed: () => Effect.succeed({ allowed: true } as const),
  isAssignmentOwnedBy: () => Effect.succeed({ allowed: true } as const),
};

const denyAllChecks: AdeToolInlineChecksShape = {
  isRoutingTargetAllowed: () =>
    Effect.succeed({ allowed: false, reason: "routing rules not built" } as const),
  isAssignmentOwnedBy: () =>
    Effect.succeed({ allowed: false, reason: "ownership unknown" } as const),
};

const noScreenbox: AdeScreenboxToolPlaneShape = {
  toolsFor: () => Effect.succeed([]),
  eligibility: () =>
    Effect.succeed({ eligible: false, reason: "Screenbox runtime is not available" } as const),
  forward: (ctx) => Effect.fail(new AdeToolExecutionError({ tool: ctx.tool, detail: "no" })),
};

/** Handlers that echo the structurally resolved caller — attribution probes. */
const echoHandlers: AdeToolHandlersShape = {
  ...adeToolHandlersUnavailable,
  fleetRead: (ctx) => Effect.succeed(`fleet:${ctx.botId}:${ctx.sessionId}`),
  updateMemory: (ctx) => Effect.succeed(`memory:${ctx.botId}:${ctx.engine}:${ctx.sessionId}`),
};

const makeEchoGate = () =>
  makeAdeToolGate({ handlers: echoHandlers, checks: allowAllChecks, screenbox: noScreenbox });

// ---------------------------------------------------------------------------
// Fake shuvcode dynamic-tool seam
// ---------------------------------------------------------------------------

interface FakeSeamError {
  readonly status?: number;
  readonly message: string;
}

interface RecordedReply {
  readonly threadId: ThreadId;
  readonly callId: string;
  readonly result: ProviderDynamicToolResult;
}

const makeFakeSeam = Effect.gen(function* () {
  const signals = yield* Queue.unbounded<ProviderDynamicToolSignal>();
  const replies = yield* Queue.unbounded<RecordedReply>();
  const configured: Array<{ threadId: ThreadId; config: ProviderDynamicToolThreadConfig }> = [];
  const cleared: Array<ThreadId> = [];
  const replyErrors: Array<FakeSeamError> = [];
  const seam: ProviderDynamicToolsShape<FakeSeamError> = {
    configureThread: (input) =>
      Effect.sync(() => {
        configured.push({
          threadId: input.threadId,
          config: {
            tools: input.tools,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          },
        });
      }),
    clearThread: (threadId) =>
      Effect.sync(() => {
        cleared.push(threadId);
      }),
    listTools: () => Effect.succeed([]),
    pendingCalls: () => Effect.succeed([]),
    replyToCall: (input) =>
      Effect.suspend(() => {
        const nextError = replyErrors.shift();
        if (nextError !== undefined) {
          return Effect.fail(nextError);
        }
        return Queue.offer(replies, {
          threadId: input.threadId,
          callId: input.callId,
          result: input.result,
        }).pipe(Effect.asVoid);
      }),
    takeSignal: Queue.take(signals),
  };
  const request = (call: ProviderDynamicToolCall) =>
    Queue.offer(signals, { kind: "requested", call }).pipe(Effect.asVoid);
  const cancel = (threadId: ThreadId, callId: string) =>
    Queue.offer(signals, { kind: "cancelled", threadId, callId }).pipe(Effect.asVoid);
  return { seam, replies, configured, cleared, replyErrors, request, cancel };
});

// ---------------------------------------------------------------------------
// Dispatch: structural attribution
// ---------------------------------------------------------------------------

describe("AdeToolGate dispatch attribution", () => {
  it.effect("resolves the same tool name on two codex sessions to distinct bots", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const handlerA = gate.makeCodexToolCallHandler(principalA);
      const handlerB = gate.makeCodexToolCallHandler(principalB);
      const invocation = (threadId: string): AdeCodexToolInvocation => ({
        threadId,
        turnId: "turn-1",
        callId: "call-1",
        tool: "update_memory",
        namespace: null,
        arguments: { content: "remember this" },
      });
      const resultA = yield* handlerA(invocation("codex-thread-a"));
      const resultB = yield* handlerB(invocation("codex-thread-b"));
      NodeAssert.deepEqual(resultA, {
        success: true,
        contentItems: [{ type: "inputText", text: `memory:${BOT_A}:codex:codex-thread-a` }],
      });
      NodeAssert.deepEqual(resultB, {
        success: true,
        contentItems: [{ type: "inputText", text: `memory:${BOT_B}:codex:codex-thread-b` }],
      });
    }),
  );

  it.effect("resolves the same tool name on two shuvcode threads to distinct bots", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");
      yield* gate.attachShuvcodeThread(fake.seam, { threadId: threadA, principal: principalA });
      yield* gate.attachShuvcodeThread(fake.seam, { threadId: threadB, principal: principalB });
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId: threadA,
        callId: "call-a",
        tool: "update_memory",
        input: { content: "a" },
      });
      yield* fake.request({
        threadId: threadB,
        callId: "call-b",
        tool: "update_memory",
        input: { content: "b" },
      });
      const first = yield* Queue.take(fake.replies);
      const second = yield* Queue.take(fake.replies);
      const byCallId = new Map([first, second].map((reply) => [reply.callId, reply]));
      NodeAssert.deepEqual(byCallId.get("call-a")?.result, {
        status: "completed",
        content: `memory:${BOT_A}:shuvcode:${threadA}`,
      });
      NodeAssert.deepEqual(byCallId.get("call-b")?.result, {
        status: "completed",
        content: `memory:${BOT_B}:shuvcode:${threadB}`,
      });
    }),
  );

  it.effect("refuses calls on shuvcode threads the gate never attached", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId: ThreadId.make("thread-foreign"),
        callId: "call-x",
        tool: "update_memory",
        input: { content: "a" },
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.result.status, "failed");
      NodeAssert.match(
        reply.result.status === "failed" ? reply.result.message : "",
        /ade:unknown-tool/,
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Registration on both kernels
// ---------------------------------------------------------------------------

describe("AdeToolGate registration", () => {
  it.effect("emits the full V1 catalog as codex dynamicTools function specs", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const specs = yield* gate.codexDynamicToolsFor(principalA);
      NodeAssert.deepEqual(
        specs.map((spec) => spec.name),
        [...ADE_BASE_TOOL_NAMES],
      );
      for (const spec of specs) {
        NodeAssert.equal(spec.type, "function");
      }
    }),
  );

  it.effect("configures shuvcode threads with the catalog and ownership metadata", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, { threadId, principal: principalA });
      NodeAssert.equal(fake.configured.length, 1);
      const configuredEntry = fake.configured[0];
      NodeAssert.ok(configuredEntry);
      NodeAssert.equal(configuredEntry.threadId, threadId);
      NodeAssert.deepEqual(
        configuredEntry.config.tools.map((tool) => tool.name),
        [...ADE_BASE_TOOL_NAMES],
      );
      NodeAssert.deepEqual(configuredEntry.config.metadata, {
        "shuv2code/ade": { botId: BOT_A, purpose: "primary-text" },
      });
    }),
  );

  it.effect("detach clears the thread and stops attributing its calls", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, { threadId, principal: principalA });
      yield* gate.detachShuvcodeThread(fake.seam, threadId);
      NodeAssert.deepEqual(fake.cleared, [threadId]);
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId,
        callId: "call-1",
        tool: "update_memory",
        input: { content: "a" },
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.result.status, "failed");
    }),
  );
});

// ---------------------------------------------------------------------------
// Inline checks: one denial path each
// ---------------------------------------------------------------------------

describe("AdeToolGate inline checks", () => {
  const makeDenyGate = () =>
    makeAdeToolGate({
      handlers: adeToolHandlersUnavailable,
      checks: denyAllChecks,
      screenbox: noScreenbox,
    });

  it.effect("denies routing when the target is not allowed", () =>
    Effect.gen(function* () {
      const gate = makeDenyGate();
      const outcome = yield* gate.dispatch(ctxFor(principalA, "create_assignment"), {
        recipientBotId: BOT_B,
        instruction: "do the thing",
      });
      NodeAssert.deepEqual(outcome, {
        _tag: "denied",
        denial: {
          _tag: "routing-target-not-allowed",
          tool: "create_assignment",
          targetBotId: BOT_B,
          reason: "routing rules not built",
        },
      });
      const steer = yield* gate.dispatch(ctxFor(principalA, "steer_primary"), {
        targetBotId: BOT_B,
        text: "focus on the tests",
      });
      NodeAssert.equal(steer._tag, "denied");
    }),
  );

  it.effect("denies result reporting for assignments the caller does not own", () =>
    Effect.gen(function* () {
      const gate = makeDenyGate();
      const outcome = yield* gate.dispatch(ctxFor(principalA, "report_assignment_result"), {
        assignmentId: "assignment-1",
        status: "completed",
        summary: "done",
      });
      NodeAssert.deepEqual(outcome, {
        _tag: "denied",
        denial: {
          _tag: "assignment-not-owned",
          tool: "report_assignment_result",
          assignmentId: "assignment-1",
          reason: "ownership unknown",
        },
      });
    }),
  );

  it.effect("denies desktop tools while Screenbox is not eligible (pre-S14 seam)", () =>
    Effect.gen(function* () {
      const gate = makeDenyGate();
      const outcome = yield* gate.dispatch(ctxFor(principalA, "desktop_screenshot"), {});
      NodeAssert.deepEqual(outcome, {
        _tag: "denied",
        denial: {
          _tag: "screenbox-not-eligible",
          tool: "desktop_screenshot",
          reason: "Screenbox runtime is not available",
        },
      });
    }),
  );

  it.effect("denies unknown tools and malformed input with typed denials", () =>
    Effect.gen(function* () {
      const gate = makeDenyGate();
      const unknown = yield* gate.dispatch(ctxFor(principalA, "made_up_tool"), {});
      NodeAssert.deepEqual(unknown, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: "made_up_tool" },
      });
      const malformed = yield* gate.dispatch(ctxFor(principalA, "create_assignment"), {
        instruction: 42,
      });
      NodeAssert.equal(malformed._tag, "denied");
      NodeAssert.equal(malformed._tag === "denied" ? malformed.denial._tag : "", "invalid-input");
    }),
  );

  it.effect(
    "passes checks and lands on the typed not-yet-available placeholder until S7/S8 plug in",
    () =>
      Effect.gen(function* () {
        const gate = makeAdeToolGate({
          handlers: adeToolHandlersUnavailable,
          checks: allowAllChecks,
          screenbox: noScreenbox,
        });
        for (const [tool, input] of [
          ["create_assignment", { recipientBotId: BOT_B, instruction: "go" }],
          ["update_memory", { content: "notes" }],
          ["fleet_read", {}],
        ] as const) {
          const outcome = yield* gate.dispatch(ctxFor(principalA, tool), input);
          NodeAssert.deepEqual(outcome, {
            _tag: "denied",
            denial: { _tag: "not-yet-available", tool },
          });
        }
      }),
  );

  it.effect("maps handler domain failures and defects to failed outcomes", () =>
    Effect.gen(function* () {
      const gate = makeAdeToolGate({
        handlers: {
          ...adeToolHandlersUnavailable,
          updateMemory: (ctx) =>
            Effect.fail(new AdeToolExecutionError({ tool: ctx.tool, detail: "memory is full" })),
          fleetRead: () =>
            Effect.sync(() => {
              throw new Error("boom");
            }),
        },
        checks: allowAllChecks,
        screenbox: noScreenbox,
      });
      const failed = yield* gate.dispatch(ctxFor(principalA, "update_memory"), { content: "x" });
      NodeAssert.deepEqual(failed, {
        _tag: "failed",
        message: "ADE tool 'update_memory' failed: memory is full",
      });
      const defect = yield* gate.dispatch(ctxFor(principalA, "fleet_read"), {});
      NodeAssert.equal(defect._tag, "failed");
    }),
  );
});

// ---------------------------------------------------------------------------
// Approvals: structurally absent from the tool plane
// ---------------------------------------------------------------------------

describe("AdeToolGate approval boundary", () => {
  it.effect("no bot-reachable registration surface names an approval operation", () =>
    Effect.gen(function* () {
      // Even a Screenbox plane that tries to smuggle approval-shaped names in
      // cannot make them reachable.
      const smugglingScreenbox: AdeScreenboxToolPlaneShape = {
        toolsFor: () =>
          Effect.succeed([
            { name: "desktop_click", description: "click", parameters: { type: "object" } },
            { name: "desktop_approve", description: "nope", parameters: { type: "object" } },
            { name: "prepare_approval", description: "nope", parameters: { type: "object" } },
            { name: "commit_approval", description: "nope", parameters: { type: "object" } },
          ]),
        eligibility: () => Effect.succeed({ eligible: true } as const),
        forward: () => Effect.succeed("forwarded"),
      };
      const gate = makeAdeToolGate({
        handlers: adeToolHandlersUnavailable,
        checks: allowAllChecks,
        screenbox: smugglingScreenbox,
      });
      const catalog = yield* gate.catalogFor(principalA);
      NodeAssert.deepEqual(
        catalog.map((tool) => tool.name),
        [...ADE_BASE_TOOL_NAMES, "desktop_click"],
      );
      for (const tool of catalog) {
        NodeAssert.doesNotMatch(tool.name, ADE_APPROVAL_NAME_PATTERN);
      }
      const codexSpecs = yield* gate.codexDynamicToolsFor(principalA);
      for (const spec of codexSpecs) {
        NodeAssert.doesNotMatch(spec.name, ADE_APPROVAL_NAME_PATTERN);
      }
    }),
  );

  it.effect("dispatch treats every approval-shaped name as unknown, even when eligible", () =>
    Effect.gen(function* () {
      const forwarded: Array<string> = [];
      const gate = makeAdeToolGate({
        handlers: echoHandlers,
        checks: allowAllChecks,
        screenbox: {
          toolsFor: () => Effect.succeed([]),
          eligibility: () => Effect.succeed({ eligible: true } as const),
          forward: (ctx) =>
            Effect.sync(() => {
              forwarded.push(ctx.tool);
              return "forwarded";
            }),
        },
      });
      for (const tool of [
        "prepare_approval",
        "commit_approval",
        "approve",
        "request_approval",
        "desktop_approve",
        "Approve_Change",
      ]) {
        const outcome = yield* gate.dispatch(ctxFor(principalA, tool), {});
        NodeAssert.deepEqual(outcome, {
          _tag: "denied",
          denial: { _tag: "unknown-tool", tool },
        });
      }
      NodeAssert.deepEqual(forwarded, []);
    }),
  );

  it.effect("the shipped base catalog itself cannot name an approval", () =>
    Effect.sync(() => {
      for (const name of ADE_BASE_TOOL_NAMES) {
        NodeAssert.doesNotMatch(name, ADE_APPROVAL_NAME_PATTERN);
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// shuvcode dispatch loop mechanics
// ---------------------------------------------------------------------------

describe("AdeToolGate shuvcode loop", () => {
  it.effect("cancellation interrupts the in-flight dispatch and suppresses the reply", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const gate = makeAdeToolGate({
        handlers: {
          ...adeToolHandlersUnavailable,
          updateMemory: () =>
            Effect.never.pipe(
              Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
            ),
          fleetRead: () => Effect.succeed("fleet"),
        },
        checks: allowAllChecks,
        screenbox: noScreenbox,
      });
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, { threadId, principal: principalA });
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId,
        callId: "call-hanging",
        tool: "update_memory",
        input: { content: "a" },
      });
      yield* fake.cancel(threadId, "call-hanging");
      yield* Deferred.await(interrupted);
      // Sentinel call: the loop must still be alive and the cancelled call
      // must never have replied.
      yield* fake.request({ threadId, callId: "call-sentinel", tool: "fleet_read", input: {} });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.callId, "call-sentinel");
      NodeAssert.deepEqual(reply.result, { status: "completed", content: "fleet" });
    }),
  );

  it.effect("treats the structured already-settled reply conflict (409) as benign", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, { threadId, principal: principalA });
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      fake.replyErrors.push({ status: 409, message: "already settled" });
      yield* fake.request({
        threadId,
        callId: "call-conflicted",
        tool: "update_memory",
        input: { content: "a" },
      });
      // The loop must survive the conflict and serve the next call.
      yield* fake.request({
        threadId,
        callId: "call-after",
        tool: "update_memory",
        input: { content: "b" },
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.callId, "call-after");
    }),
  );
});

// ---------------------------------------------------------------------------
// Fail-closed layer wiring
// ---------------------------------------------------------------------------

describe("AdeToolGate.layerFailClosed", () => {
  it.effect("denies routing, ownership, and Screenbox by default", () =>
    Effect.gen(function* () {
      const gate = yield* AdeToolGate;
      const cases: ReadonlyArray<readonly [string, unknown, AdeToolOutcome["_tag"]]> = [
        ["create_assignment", { recipientBotId: BOT_B, instruction: "go" }, "denied"],
        [
          "report_assignment_result",
          { assignmentId: "a", status: "failed", summary: "s" },
          "denied",
        ],
        ["desktop_look", {}, "denied"],
        ["update_memory", { content: "x" }, "denied"],
      ];
      for (const [tool, input, expected] of cases) {
        const outcome = yield* gate.dispatch(ctxFor(principalA, tool), input);
        NodeAssert.equal(outcome._tag, expected);
        if (outcome._tag === "denied") {
          // Every default denial renders a model-readable message.
          NodeAssert.ok(renderAdeToolDenial(outcome.denial).startsWith("[ade:"));
        }
      }
    }).pipe(Effect.provide(AdeToolGate.layerFailClosed)),
  );
});
