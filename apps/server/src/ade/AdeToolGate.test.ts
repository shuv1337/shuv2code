import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { describe } from "vite-plus/test";

import { BotId, KernelSessionId, ThreadId } from "@shuv2code/contracts";

import type { AdeCodexToolInvocation } from "./AdeCodexKernelAdapter.ts";
import {
  ADE_APPROVAL_NAME_PATTERN,
  ADE_BASE_TOOL_NAMES,
  AdeShuvcodeAttachConflictError,
  AdeToolExecutionError,
  AdeToolGate,
  AdeToolHandlers,
  adeToolHandlersUnavailable,
  makeAdeToolGate,
  renderAdeToolDenial,
  sanitizeAdeToolFailureDetail,
  type AdeScreenboxToolPlaneShape,
  type AdeToolCallContext,
  type AdeToolHandlersShape,
  type AdeToolInlineChecksShape,
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

const SESSION_A = KernelSessionId.make("oc-session-a");
const SESSION_B = KernelSessionId.make("oc-session-b");

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
  isBotProvisioningAllowed: () => Effect.succeed({ allowed: true } as const),
};

const denyAllChecks: AdeToolInlineChecksShape = {
  isRoutingTargetAllowed: () =>
    Effect.succeed({ allowed: false, reason: "routing rules not built" } as const),
  isAssignmentOwnedBy: () =>
    Effect.succeed({ allowed: false, reason: "ownership unknown" } as const),
  isBotProvisioningAllowed: () =>
    Effect.succeed({ allowed: false, reason: "not a coordinator" } as const),
};

const noScreenbox: AdeScreenboxToolPlaneShape = {
  toolsFor: () => Effect.succeed([]),
  eligibility: () =>
    Effect.succeed({ eligible: false, reason: "Screenbox runtime is not available" } as const),
  forward: (ctx) => Effect.fail(new AdeToolExecutionError({ tool: ctx.tool, detail: "no" })),
};

const screenboxDef = (name: string) => ({
  name,
  description: `screenbox ${name}`,
  parameters: { type: "object" } as const,
});

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
  const configureErrors: Array<FakeSeamError> = [];
  /** Signals injected by configureThread itself — the live-session drain. */
  const drainOnConfigure: Array<ProviderDynamicToolCall> = [];
  const seam: ProviderDynamicToolsShape<FakeSeamError> = {
    configureThread: (input) =>
      Effect.suspend(() => {
        const nextError = configureErrors.shift();
        if (nextError !== undefined) {
          return Effect.fail(nextError);
        }
        configured.push({
          threadId: input.threadId,
          config: {
            tools: input.tools,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          },
        });
        const drained = drainOnConfigure.splice(0);
        return Effect.forEach(
          drained,
          (call) => Queue.offer(signals, { kind: "requested", call }),
          { discard: true },
        );
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
  return {
    seam,
    replies,
    configured,
    cleared,
    replyErrors,
    configureErrors,
    drainOnConfigure,
    request,
    cancel,
  };
});

// ---------------------------------------------------------------------------
// Dispatch: structural attribution
// ---------------------------------------------------------------------------

describe("AdeToolGate dispatch attribution", () => {
  it.effect("resolves the same tool name on two overlapping codex sessions to distinct bots", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      let inFlightCount = 0;
      const gate = makeAdeToolGate({
        handlers: {
          ...adeToolHandlersUnavailable,
          updateMemory: (ctx) =>
            Effect.gen(function* () {
              inFlightCount += 1;
              if (inFlightCount === 2) {
                yield* Deferred.succeed(started, undefined);
              }
              yield* Deferred.await(release);
              return `memory:${ctx.botId}:${ctx.engine}:${ctx.sessionId}`;
            }),
        },
        checks: allowAllChecks,
        screenbox: noScreenbox,
      });
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
      // Both calls are genuinely concurrent: neither completes before both
      // have entered the handler.
      const fiberA = yield* Effect.forkChild(handlerA(invocation("codex-thread-a")));
      const fiberB = yield* Effect.forkChild(handlerB(invocation("codex-thread-b")));
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      const resultA = yield* Fiber.join(fiberA);
      const resultB = yield* Fiber.join(fiberB);
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

  it.effect(
    "resolves the same tool name on two overlapping shuvcode threads to distinct bots",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let inFlightCount = 0;
        const gate = makeAdeToolGate({
          handlers: {
            ...adeToolHandlersUnavailable,
            updateMemory: (ctx) =>
              Effect.gen(function* () {
                inFlightCount += 1;
                if (inFlightCount === 2) {
                  yield* Deferred.succeed(started, undefined);
                }
                yield* Deferred.await(release);
                return `memory:${ctx.botId}:${ctx.engine}:${ctx.sessionId}`;
              }),
          },
          checks: allowAllChecks,
          screenbox: noScreenbox,
        });
        const fake = yield* makeFakeSeam;
        const threadA = ThreadId.make("thread-a");
        const threadB = ThreadId.make("thread-b");
        yield* gate.attachShuvcodeThread(fake.seam, {
          threadId: threadA,
          sessionId: SESSION_A,
          principal: principalA,
        });
        yield* gate.attachShuvcodeThread(fake.seam, {
          threadId: threadB,
          sessionId: SESSION_B,
          principal: principalB,
        });
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
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        const first = yield* Queue.take(fake.replies);
        const second = yield* Queue.take(fake.replies);
        const byCallId = new Map([first, second].map((reply) => [reply.callId, reply]));
        // ctx.sessionId is the kernel-native session id supplied at attach —
        // never the shuv2code ThreadId.
        NodeAssert.deepEqual(byCallId.get("call-a")?.result, {
          status: "completed",
          content: `memory:${BOT_A}:shuvcode:${SESSION_A}`,
        });
        NodeAssert.deepEqual(byCallId.get("call-b")?.result, {
          status: "completed",
          content: `memory:${BOT_B}:shuvcode:${SESSION_B}`,
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
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
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

  it.effect("attributes calls drained by configureThread itself (re-attach path)", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      // The live-session configure drains this pending call into the feed
      // before attachShuvcodeThread returns — the binding must already exist.
      fake.drainOnConfigure.push({
        threadId,
        callId: "call-drained",
        tool: "update_memory",
        input: { content: "restored" },
      });
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.deepEqual(reply.result, {
        status: "completed",
        content: `memory:${BOT_A}:shuvcode:${SESSION_A}`,
      });
    }),
  );

  it.effect("rolls the binding back when configureThread fails", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      fake.configureErrors.push({ status: 500, message: "configure failed" });
      const attachResult = yield* gate
        .attachShuvcodeThread(fake.seam, {
          threadId,
          sessionId: SESSION_A,
          principal: principalA,
        })
        .pipe(Effect.result);
      NodeAssert.equal(attachResult._tag, "Failure");
      // No binding survived: calls on the thread are unattributable.
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId,
        callId: "call-1",
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

  it.effect("refuses re-attaching a live thread for a different principal", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      const conflicted = yield* gate
        .attachShuvcodeThread(fake.seam, {
          threadId,
          sessionId: SESSION_B,
          principal: principalB,
        })
        .pipe(Effect.result);
      NodeAssert.equal(conflicted._tag, "Failure");
      if (conflicted._tag === "Failure") {
        const failure = conflicted.failure;
        NodeAssert.ok("_tag" in failure && failure._tag === "AdeShuvcodeAttachConflictError");
        const conflict = failure as AdeShuvcodeAttachConflictError;
        NodeAssert.equal(conflict.attachedBotId, BOT_A);
        NodeAssert.equal(conflict.requestedBotId, BOT_B);
      }
      // Same-principal re-attach (restart path) stays allowed.
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      // After an explicit detach the thread may be re-bound.
      yield* gate.detachShuvcodeThread(fake.seam, threadId);
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_B,
        principal: principalB,
      });
    }),
  );

  it.effect("detach clears the thread and stops attributing its calls", () =>
    Effect.gen(function* () {
      const gate = makeEchoGate();
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
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
      screenbox: {
        ...noScreenbox,
        toolsFor: () => Effect.succeed([screenboxDef("desktop_screenshot")]),
      },
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

  it.effect("denies catalogued desktop tools while Screenbox is not eligible (pre-S14 seam)", () =>
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

  it.effect("denies desktop names outside the sanitized Screenbox catalog before forward", () =>
    Effect.gen(function* () {
      const forwarded: Array<string> = [];
      const gate = makeAdeToolGate({
        handlers: adeToolHandlersUnavailable,
        checks: allowAllChecks,
        screenbox: {
          // Eligible plane whose catalog carries one valid def and one the
          // sanitizer drops (invalid name).
          toolsFor: () =>
            Effect.succeed([screenboxDef("desktop_click"), screenboxDef("desktop_bad name")]),
          eligibility: () => Effect.succeed({ eligible: true } as const),
          forward: (ctx) =>
            Effect.sync(() => {
              forwarded.push(ctx.tool);
              return "forwarded";
            }),
        },
      });
      // Guessed name never supplied by the seam → unknown-tool, no forward.
      const guessed = yield* gate.dispatch(ctxFor(principalA, "desktop_shell"), {});
      NodeAssert.deepEqual(guessed, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: "desktop_shell" },
      });
      // Sanitizer-dropped def → unknown-tool, no forward.
      const dropped = yield* gate.dispatch(ctxFor(principalA, "desktop_bad name"), {});
      NodeAssert.equal(dropped._tag, "denied");
      // The catalogued def forwards.
      const ok = yield* gate.dispatch(ctxFor(principalA, "desktop_click"), {});
      NodeAssert.deepEqual(ok, { _tag: "completed", content: "forwarded" });
      NodeAssert.deepEqual(forwarded, ["desktop_click"]);
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

  it.effect("contains defects thrown by an inline check on both kernel bridges", () =>
    Effect.gen(function* () {
      const throwingChecks: AdeToolInlineChecksShape = {
        ...allowAllChecks,
        isRoutingTargetAllowed: () =>
          Effect.sync(() => {
            throw new Error("checks backend exploded");
          }),
      };
      const gate = makeAdeToolGate({
        handlers: echoHandlers,
        checks: throwingChecks,
        screenbox: noScreenbox,
      });
      const input = { recipientBotId: BOT_B, instruction: "go" };
      // Codex bridge: the handler still resolves to a failed tool result —
      // the defect never escapes into handleServerRequest.
      const codexResult = yield* gate.makeCodexToolCallHandler(principalA)({
        threadId: "codex-thread-a",
        turnId: "turn-1",
        callId: "call-1",
        tool: "create_assignment",
        namespace: null,
        arguments: input,
      });
      NodeAssert.equal(codexResult.success, false);
      const firstItem = codexResult.contentItems[0];
      NodeAssert.ok(firstItem !== undefined && firstItem.type === "inputText");
      NodeAssert.match(firstItem.text, /\[ade:failed\]/);
      // shuvcode bridge: the dispatch fiber survives and still settles the
      // call with a reply (the S4 requested↔reply pairing holds).
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      yield* fake.request({
        threadId,
        callId: "call-check-defect",
        tool: "create_assignment",
        input,
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.callId, "call-check-defect");
      NodeAssert.equal(reply.result.status, "failed");
      NodeAssert.match(
        reply.result.status === "failed" ? reply.result.message : "",
        /\[ade:failed\]/,
      );
    }),
  );

  it.effect("bounds and scrubs handler failure detail before it reaches the model", () =>
    Effect.sync(() => {
      const noisy = `line1\u0007\u0000${"x".repeat(5_000)}`;
      const rendered = new AdeToolExecutionError({ tool: "update_memory", detail: noisy }).message;
      NodeAssert.ok(!rendered.includes("\u0000") && !rendered.includes("\u0007"));
      NodeAssert.ok(rendered.length < 2_200);
      NodeAssert.match(rendered, /truncated/);
      NodeAssert.equal(sanitizeAdeToolFailureDetail("plain"), "plain");
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
            screenboxDef("desktop_click"),
            screenboxDef("desktop_approve"),
            screenboxDef("prepare_approval"),
            screenboxDef("commit_approval"),
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
      const fake = yield* makeFakeSeam;
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId: ThreadId.make("thread-a"),
        sessionId: SESSION_A,
        principal: principalA,
      });
      for (const tool of fake.configured[0]?.config.tools ?? []) {
        NodeAssert.doesNotMatch(tool.name, ADE_APPROVAL_NAME_PATTERN);
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
          toolsFor: () => Effect.succeed([screenboxDef("desktop_approve")]),
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

  it.effect("denies create_bot with a rule-naming denial when the check refuses", () =>
    Effect.gen(function* () {
      const gate = makeAdeToolGate({
        handlers: echoHandlers,
        checks: denyAllChecks,
        screenbox: noScreenbox,
      });
      const outcome = yield* gate.dispatch(ctxFor(principalA, "create_bot"), {
        templateId: "reviewer",
      });
      NodeAssert.equal(outcome._tag, "denied");
      if (outcome._tag !== "denied") return;
      NodeAssert.equal(outcome.denial._tag, "bot-provisioning-not-allowed");
      NodeAssert.equal(
        renderAdeToolDenial(outcome.denial),
        "[ade:bot-provisioning-not-allowed] 'create_bot' refused: not a coordinator",
      );
    }),
  );

  it.effect("refuses a reserved template before any check or handler runs", () =>
    Effect.gen(function* () {
      let checked = false;
      const gate = makeAdeToolGate({
        handlers: echoHandlers,
        checks: {
          ...allowAllChecks,
          isBotProvisioningAllowed: () =>
            Effect.sync(() => {
              checked = true;
              return { allowed: true } as const;
            }),
        },
        screenbox: noScreenbox,
      });
      const outcome = yield* gate.dispatch(ctxFor(principalA, "create_bot"), {
        templateId: "firstmate",
      });
      NodeAssert.equal(outcome._tag, "denied");
      NodeAssert.equal(outcome._tag === "denied" ? outcome.denial._tag : "", "invalid-input");
      NodeAssert.equal(checked, false);
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
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
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
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
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

  it.effect("replays the recorded outcome for a re-requested call instead of re-executing", () =>
    Effect.gen(function* () {
      let executions = 0;
      const gate = makeAdeToolGate({
        handlers: {
          ...adeToolHandlersUnavailable,
          updateMemory: () =>
            Effect.sync(() => {
              executions += 1;
              return `run-${executions}`;
            }),
        },
        checks: allowAllChecks,
        screenbox: noScreenbox,
      });
      const fake = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-a");
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
      // First execution replies but the reply races provider-side
      // cancellation (benign 409) — provider still considers the call open.
      fake.replyErrors.push({ status: 409, message: "already settled" });
      yield* fake.request({
        threadId,
        callId: "call-1",
        tool: "update_memory",
        input: { content: "a" },
      });
      // S4: the still-pending call is re-`requested` on the next attach.
      yield* gate.attachShuvcodeThread(fake.seam, {
        threadId,
        sessionId: SESSION_A,
        principal: principalA,
      });
      yield* fake.request({
        threadId,
        callId: "call-1",
        tool: "update_memory",
        input: { content: "a" },
      });
      const reply = yield* Queue.take(fake.replies);
      NodeAssert.equal(reply.callId, "call-1");
      NodeAssert.deepEqual(reply.result, { status: "completed", content: "run-1" });
      NodeAssert.equal(executions, 1);
    }),
  );

  it.effect(
    "does not execute a previously-run call as a new principal after detach + re-attach",
    () =>
      Effect.gen(function* () {
        const executedBy: Array<string> = [];
        const gate = makeAdeToolGate({
          handlers: {
            ...adeToolHandlersUnavailable,
            updateMemory: (ctx) =>
              Effect.sync(() => {
                executedBy.push(ctx.botId);
                return `memory:${ctx.botId}`;
              }),
          },
          checks: allowAllChecks,
          screenbox: noScreenbox,
        });
        const fake = yield* makeFakeSeam;
        const threadId = ThreadId.make("thread-a");
        yield* gate.attachShuvcodeThread(fake.seam, {
          threadId,
          sessionId: SESSION_A,
          principal: principalA,
        });
        yield* Effect.forkChild(gate.runShuvcodeDispatchLoop(fake.seam));
        yield* fake.request({
          threadId,
          callId: "call-1",
          tool: "update_memory",
          input: { content: "a" },
        });
        const firstReply = yield* Queue.take(fake.replies);
        NodeAssert.deepEqual(firstReply.result, {
          status: "completed",
          content: `memory:${BOT_A}`,
        });
        // Rebind the thread to a different principal; detach drops the
        // dedupe memory with the binding, so a re-request executes under the
        // NEW owner — never replays or re-attributes bot A's execution.
        yield* gate.detachShuvcodeThread(fake.seam, threadId);
        yield* gate.attachShuvcodeThread(fake.seam, {
          threadId,
          sessionId: SESSION_B,
          principal: principalB,
        });
        yield* fake.request({
          threadId,
          callId: "call-2",
          tool: "update_memory",
          input: { content: "b" },
        });
        const secondReply = yield* Queue.take(fake.replies);
        NodeAssert.deepEqual(secondReply.result, {
          status: "completed",
          content: `memory:${BOT_B}`,
        });
        NodeAssert.deepEqual(executedBy, [BOT_A, BOT_B]);
      }),
  );
});

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

describe("AdeToolGate layers", () => {
  it.effect("denies routing, ownership, and unknown desktop names by default", () =>
    Effect.gen(function* () {
      const gate = yield* AdeToolGate;
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        ["create_assignment", { recipientBotId: BOT_B, instruction: "go" }],
        ["report_assignment_result", { assignmentId: "a", status: "failed", summary: "s" }],
        ["desktop_look", {}],
        ["update_memory", { content: "x" }],
      ];
      for (const [tool, input] of cases) {
        const outcome = yield* gate.dispatch(ctxFor(principalA, tool), input);
        NodeAssert.equal(outcome._tag, "denied");
        if (outcome._tag === "denied") {
          // Every default denial renders a model-readable message.
          NodeAssert.ok(renderAdeToolDenial(outcome.denial).startsWith("[ade:"));
        }
      }
    }).pipe(Effect.provide(AdeToolGate.layerFailClosed)),
  );

  it.effect("layerPartial patches stack: S7 and S8 slices compose without reverting", () =>
    Effect.gen(function* () {
      const handlers = yield* AdeToolHandlers;
      const memory = yield* handlers.updateMemory(ctxFor(principalA, "update_memory"), {
        content: "notes",
      });
      NodeAssert.equal(memory, "s8-memory");
      const fleet = yield* handlers.fleetRead(ctxFor(principalA, "fleet_read"), {});
      NodeAssert.equal(fleet, "s7-fleet");
      // Slices neither layer provided stay at the not-yet-available base.
      const steer = yield* handlers
        .steerPrimary(ctxFor(principalA, "steer_primary"), {
          targetBotId: BOT_B,
          text: "go",
        })
        .pipe(Effect.result);
      NodeAssert.equal(steer._tag, "Failure");
    }).pipe(
      Effect.provide(
        AdeToolHandlers.layerPartial({ updateMemory: () => Effect.succeed("s8-memory") }).pipe(
          Layer.provide(
            AdeToolHandlers.layerPartial({ fleetRead: () => Effect.succeed("s7-fleet") }).pipe(
              Layer.provide(AdeToolHandlers.layerUnavailable),
            ),
          ),
        ),
      ),
    ),
  );
});

describe("AdeToolGate.rebindShuvcodeSession", () => {
  it.effect("records the real kernel session without touching the provider", () =>
    Effect.gen(function* () {
      const gate = yield* AdeToolGate;
      const seam = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-rebind");
      const principal = { botId: "bot-1" as BotId, purpose: "primary-text" } as const;

      // Pre-session attach: the catalog rides session creation.
      yield* gate.attachShuvcodeThread(seam.seam, {
        threadId,
        sessionId: threadId as unknown as KernelSessionId,
        principal,
      });
      const configuresAfterAttach = seam.configured.length;

      yield* gate.rebindShuvcodeSession({
        threadId,
        sessionId: "ses_real" as KernelSessionId,
        principal,
      });

      // The whole point: correcting the recorded session id must not push the
      // catalog a second time. That PUT is redundant after session.create and
      // fatal on a kernel build without the dynamic-tool routes.
      NodeAssert.equal(seam.configured.length, configuresAfterAttach);
    }).pipe(Effect.provide(AdeToolGate.layerFailClosed)),
  );

  it.effect("refuses to re-attribute a thread to a different bot", () =>
    Effect.gen(function* () {
      const gate = yield* AdeToolGate;
      const seam = yield* makeFakeSeam;
      const threadId = ThreadId.make("thread-rebind-conflict");
      yield* gate.attachShuvcodeThread(seam.seam, {
        threadId,
        sessionId: "ses_a" as KernelSessionId,
        principal: { botId: "bot-1" as BotId, purpose: "primary-text" },
      });

      const error = yield* Effect.flip(
        gate.rebindShuvcodeSession({
          threadId,
          sessionId: "ses_b" as KernelSessionId,
          principal: { botId: "bot-2" as BotId, purpose: "primary-text" },
        }),
      );
      NodeAssert.equal(error._tag, "AdeShuvcodeAttachConflictError");
    }).pipe(Effect.provide(AdeToolGate.layerFailClosed)),
  );
});
