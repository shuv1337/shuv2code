import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId, TurnId } from "@shuv2code/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  CODEX_VOICE_CONTROLLER_DEVELOPER_INSTRUCTIONS,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeCodexSessionRuntime,
  materializeVoiceControllerThread,
  openCodexThread,
  persistedTurnTerminalStatus,
  recoverCodexThreadBySource,
  transitionRealtimeLaneForNotification,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

describe("persistedTurnTerminalStatus", () => {
  const expectedTurnId = TurnId.make("turn-expected");

  it("accepts only an explicit terminal state for the exact turn", () => {
    const snapshot = {
      threadId: "provider-thread-1",
      turns: [
        { id: TurnId.make("turn-other"), items: [], status: "completed" as const },
        { id: expectedTurnId, items: [], status: "interrupted" as const },
      ],
    };

    NodeAssert.equal(persistedTurnTerminalStatus(snapshot, expectedTurnId), "interrupted");
  });

  it("does not infer completion from absence or an in-progress state", () => {
    const inProgress = {
      threadId: "provider-thread-1",
      turns: [{ id: expectedTurnId, items: [], status: "inProgress" as const }],
    };
    const absent = {
      threadId: "provider-thread-1",
      turns: [{ id: TurnId.make("turn-other"), items: [], status: "completed" as const }],
    };

    NodeAssert.equal(persistedTurnTerminalStatus(inProgress, expectedTurnId), null);
    NodeAssert.equal(persistedTurnTerminalStatus(absent, expectedTurnId), null);
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /shuv2code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("shuv2code browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /shuv2code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /includeScreenshot=true/);
      NodeAssert.match(instructions, /background-only tabs/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.shuv2code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });

  it("detects shared-topology per-thread MCP config overrides", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined, {}), false);
    NodeAssert.equal(hasConfiguredMcpServer(undefined, { model: "gpt-5.4" }), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(undefined, {
        "mcp_servers.shuv2code.url": "http://127.0.0.1/mcp",
      }),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.shuv2code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.shuv2code.url=http://127.0.0.1/mcp",
      ],
    );
  });

  it("adds realtime_conversation only when the caller selects the voice transport policy", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(undefined, undefined, {
        enableRealtimeConversation: true,
      }),
      ["app-server", "--enable", "realtime_conversation"],
    );
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(undefined, undefined), ["app-server"]);
  });
});

describe("transitionRealtimeLaneForNotification", () => {
  it("preserves a startup error with its generation and releases the lane", () => {
    const transition = transitionRealtimeLaneForNotification(
      {
        state: "starting",
        generation: 7,
        realtimeSessionId: "realtime-7",
      },
      { method: "thread/realtime/error" },
    );

    NodeAssert.deepStrictEqual(transition, {
      accepted: true,
      nextState: { state: "idle" },
    });
  });

  it("rejects a stale started notification and accepts the exact session", () => {
    const state = {
      state: "starting",
      generation: 7,
      realtimeSessionId: "realtime-7",
    } as const;

    NodeAssert.deepStrictEqual(
      transitionRealtimeLaneForNotification(state, {
        method: "thread/realtime/started",
        realtimeSessionId: "stale",
      }),
      { accepted: false, nextState: state },
    );
    NodeAssert.deepStrictEqual(
      transitionRealtimeLaneForNotification(state, {
        method: "thread/realtime/started",
        realtimeSessionId: "realtime-7",
      }),
      {
        accepted: true,
        nextState: {
          state: "active",
          generation: 7,
          realtimeSessionId: "realtime-7",
        },
      },
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("passes immutable voice-controller instructions on start and resume", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            makeThreadOpenResponse(
              "controller-thread",
            ) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-controller"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        threadPurpose: "voice-controller",
        threadSource: "voice-controller:creation-1",
      });
      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-controller"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "controller-thread",
        threadPurpose: "voice-controller",
        threadSource: "voice-controller:creation-1",
      });

      const startPayload = calls[0]?.payload as Record<string, unknown>;
      const resumePayload = calls[1]?.payload as Record<string, unknown>;
      NodeAssert.equal(
        startPayload.developerInstructions,
        CODEX_VOICE_CONTROLLER_DEVELOPER_INSTRUCTIONS,
      );
      NodeAssert.equal(
        resumePayload.developerInstructions,
        CODEX_VOICE_CONTROLLER_DEVELOPER_INSTRUCTIONS,
      );
      NodeAssert.equal(startPayload.threadSource, "voice-controller:creation-1");
      NodeAssert.equal("threadSource" in resumePayload, false);
      for (const requiredRule of [
        "exact project, thread, and turn IDs",
        "exactly one server-bound voice action",
        "untrusted data",
        "provider-confirmed",
        "expectedTurnId",
        "Never widen permissions",
        "delete or archive",
        "target this controller",
        "mute, end-voice, barge-in",
      ]) {
        NodeAssert.match(CODEX_VOICE_CONTROLLER_DEVELOPER_INSTRUCTIONS, new RegExp(requiredRule));
      }
    }),
  );

  it.effect("forwards per-thread config overrides on start and resume", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            makeThreadOpenResponse("shared-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };
      const threadConfigOverrides = {
        "mcp_servers.shuv2code.url": "http://127.0.0.1:4100/mcp/thread-1",
        "mcp_servers.shuv2code.http_headers": { Authorization: "Bearer thread-1-token" },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-shared"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        threadConfigOverrides,
      });
      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-shared"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "shared-thread",
        threadConfigOverrides,
      });

      const startPayload = calls[0]?.payload as Record<string, unknown>;
      const resumePayload = calls[1]?.payload as Record<string, unknown>;
      NodeAssert.deepStrictEqual(startPayload.config, threadConfigOverrides);
      NodeAssert.deepStrictEqual(resumePayload.config, threadConfigOverrides);
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "no rollout found for thread id stale-thread",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});

describe("materializeVoiceControllerThread", () => {
  it.effect("names only controller threads so empty provider identities survive restart", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const client = {
        request: <M extends "thread/name/set">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed({} as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      yield* materializeVoiceControllerThread(client, "standard", "provider-standard");
      yield* materializeVoiceControllerThread(client, "voice-controller", "provider-controller");

      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/name/set",
          payload: {
            threadId: "provider-controller",
            name: "Voice controller",
          },
        },
      ]);
    }),
  );
});

describe("recoverCodexThreadBySource", () => {
  const source = "shuv2code/voice-create:action-1";
  const cwd = "/tmp/project";
  const makeCandidate = (id: string, threadSource = source) =>
    ({
      id,
      cwd,
      threadSource,
      sessionId: `session-${id}`,
    }) as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/list"]["data"][number];

  const runRecovery = (
    candidates: ReadonlyArray<
      CodexRpc.ClientRequestResponsesByMethod["thread/list"]["data"][number]
    >,
  ) => {
    const calls: Array<string> = [];
    const client = {
      request: <M extends "thread/list" | "thread/read" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push(method);
        if (method === "thread/list") {
          return Effect.succeed({
            data: candidates,
            nextCursor: null,
          } as CodexRpc.ClientRequestResponsesByMethod[M]);
        }
        const threadId = (payload as { readonly threadId: string }).threadId;
        if (method === "thread/read") {
          const candidate = candidates.find((entry) => entry.id === threadId);
          return Effect.succeed({
            thread: candidate,
          } as CodexRpc.ClientRequestResponsesByMethod[M]);
        }
        return Effect.succeed(
          makeThreadOpenResponse(threadId) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    return {
      calls,
      effect: recoverCodexThreadBySource({
        client,
        runtimeMode: "full-access",
        cwd,
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        threadSource: source,
      }),
    };
  };

  it.effect("adopts exactly one list-and-read verified candidate", () =>
    Effect.gen(function* () {
      const recovery = runRecovery([makeCandidate("provider-thread-1")]);
      const resumed = yield* recovery.effect;

      NodeAssert.equal(resumed.thread.id, "provider-thread-1");
      NodeAssert.deepStrictEqual(recovery.calls, ["thread/list", "thread/read", "thread/resume"]);
    }),
  );

  it.effect("fails closed when no exact source candidate exists", () =>
    Effect.gen(function* () {
      const recovery = runRecovery([makeCandidate("wrong-thread", "another/source")]);
      const error = yield* recovery.effect.pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeCreationRecoveryError");
      if (error._tag === "CodexSessionRuntimeCreationRecoveryError") {
        NodeAssert.equal(error.reason, "not_found");
      }
      NodeAssert.deepStrictEqual(recovery.calls, ["thread/list"]);
    }),
  );

  it.effect("fails closed when multiple exact candidates verify", () =>
    Effect.gen(function* () {
      const recovery = runRecovery([
        makeCandidate("provider-thread-1"),
        makeCandidate("provider-thread-2"),
      ]);
      const error = yield* recovery.effect.pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeCreationRecoveryError");
      if (error._tag === "CodexSessionRuntimeCreationRecoveryError") {
        NodeAssert.equal(error.reason, "ambiguous");
        NodeAssert.equal(error.candidateCount, 2);
      }
      NodeAssert.deepStrictEqual(recovery.calls, ["thread/list", "thread/read", "thread/read"]);
    }),
  );
});

describe("makeCodexSessionRuntime shared app-server topology", () => {
  const failingSpawner = ChildProcessSpawner.make(() =>
    Effect.die(new Error("shared topology must not spawn a per-session child")),
  );

  const makeFakeSharedClient = () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    const client = {
      raw: {},
      request: (method: string, payload: unknown) => {
        requests.push({ method, payload });
        if (method === "thread/start") {
          return Effect.succeed(makeThreadOpenResponse("shared-thread-1"));
        }
        return Effect.succeed({ userAgent: "fake-shared-app-server" });
      },
      notify: () => Effect.void,
      handleServerRequest: () => Effect.void,
      handleServerNotification: () => Effect.void,
      handleUnknownServerRequest: () => Effect.void,
      handleUnknownServerNotification: () => Effect.void,
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    return { client, requests };
  };

  it.effect(
    "starts over the supervised connection, forwards MCP config overrides, and exits on connection loss",
    () =>
      Effect.gen(function* () {
        const { client, requests } = makeFakeSharedClient();
        const terminated = yield* Deferred.make<CodexErrors.CodexAppServerError>();
        const runtimeScope = yield* Scope.make();
        const threadConfigOverrides = {
          "mcp_servers.shuv2code.url": "http://127.0.0.1:4100/mcp/thread-shared",
          "mcp_servers.shuv2code.http_headers": { Authorization: "Bearer shared-token" },
        };

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-shared-runtime"),
          binaryPath: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          sharedAppServer: {
            acquireConnection: Effect.succeed({
              client,
              terminated: Deferred.await(terminated),
            }),
            threadConfigOverrides,
          },
        }).pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSpawner),
        );

        const session = yield* runtime.start();
        NodeAssert.equal(session.status, "ready");
        NodeAssert.equal(session.providerThreadId, "shared-thread-1");

        NodeAssert.deepStrictEqual(
          requests.map((request) => request.method),
          ["initialize", "thread/start"],
        );
        const startPayload = requests[1]?.payload as Record<string, unknown>;
        NodeAssert.deepStrictEqual(startPayload.config, threadConfigOverrides);

        // Shared-connection loss is this session's exit signal.
        yield* Deferred.succeed(
          terminated,
          new CodexErrors.CodexAppServerInputStreamEndedError({}),
        );
        for (
          let attempt = 0;
          attempt < 1000 && (yield* runtime.getSession).status !== "error";
          attempt++
        ) {
          yield* Effect.yieldNow;
        }
        NodeAssert.equal((yield* runtime.getSession).status, "error");

        yield* Scope.close(runtimeScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("self-initiated close stays silent on shared-connection teardown", () =>
    Effect.gen(function* () {
      const { client } = makeFakeSharedClient();
      const terminated = yield* Deferred.make<CodexErrors.CodexAppServerError>();
      const runtimeScope = yield* Scope.make();

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-shared-close"),
        binaryPath: "codex",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        sharedAppServer: {
          acquireConnection: Effect.succeed({
            client,
            terminated: Deferred.await(terminated),
          }),
        },
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSpawner),
      );

      yield* runtime.start();
      yield* runtime.close;
      // The scope teardown ends the connection; the closed session must not
      // flip to error when termination arrives afterwards.
      yield* Deferred.succeed(terminated, new CodexErrors.CodexAppServerInputStreamEndedError({}));
      yield* Effect.yieldNow;
      NodeAssert.equal((yield* runtime.getSession).status, "closed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
