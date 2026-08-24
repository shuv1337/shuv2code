/**
 * ADE-facing Codex kernel adapter (spec `docs/ade/ADE-V1-SPEC.md` §3.3).
 *
 * Binds ADE bot sessions to the shared supervised Codex app-server
 * (`CodexAppServerSupervisor`) over one dedicated ADE connection per
 * supervisor key. The adapter owns:
 *
 * - thread lifecycle (`thread/start` with experimental `dynamicTools`,
 *   `thread/resume` with client-side tool registration restored,
 *   `thread/fork` with lineage bookkeeping into binding descriptors);
 * - `thread/inject_items` for assignment-result / notification delivery into
 *   model-visible history;
 * - `turn/steer` vs `turn/interrupt` as distinct operations;
 * - approval/elicitation capture (the `requestApproval` family,
 *   `item/tool/requestUserInput`, `mcpServer/elicitation/request`) surfaced as
 *   respondable events — the Needs You seam (§4.8/S13 consumes, S5 designs);
 * - `serviceName`/`clientInfo` tagging of every ADE thread and connection.
 *
 * Coexistence with realtime voice (#131): every consumer of the shared
 * process owns its own WebSocket-over-unix-socket connection, and upstream
 * delivers thread-scoped notifications only to connections attached to that
 * thread. This adapter therefore only ever observes its own threads; foreign
 * thread traffic is dropped defensively by the thread registry. Listener auth
 * is structural in V1: the supervisor owns a private unix control socket
 * (mode 0600) under the server runtime dir — `--ws-auth` applies only to
 * non-loopback `ws://` listeners, which the supervisor never opens.
 *
 * This is the S6 tool-gate seam: the gate plugs in as `onToolCall`; no
 * dispatch policy lives here.
 */
import type {
  BotExecutionBinding,
  BotExecutionBindingId,
  BotExecutionBindingPurpose,
  BotExecutionBindingStatus,
  BotId,
  IsoDateTime,
} from "@shuv2code/contracts";
import { KernelSessionId } from "@shuv2code/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import packageJson from "../../package.json" with { type: "json" };
import {
  CodexAppServerSupervisor,
  type CodexAppServerConnection,
  type CodexAppServerSupervisorKey,
} from "../provider/Services/CodexAppServerSupervisor.ts";

// ---------------------------------------------------------------------------
// Tagging (spec §3.3 — serviceName + clientInfo)
// ---------------------------------------------------------------------------

/** `serviceName` stamped on every ADE-owned Codex thread. */
export const ADE_CODEX_SERVICE_NAME = "shuv2code-ade";

/** `threadSource` prefix for ADE-owned threads (recovery + ancestry filters). */
export const ADE_CODEX_THREAD_SOURCE_PREFIX = "shuv2code/ade";

export const adeCodexThreadSource = (botId: BotId, purpose: BotExecutionBindingPurpose): string =>
  `${ADE_CODEX_THREAD_SOURCE_PREFIX}/${botId}/${purpose}`;

/**
 * ADE connection identity. Distinct from the coding-tool client
 * (`shuv2code_desktop`) so shared-process logs and analytics attribute ADE
 * traffic to ADE.
 */
export function buildAdeCodexInitializeParams(): EffectCodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "shuv2code_ade",
      title: "shuv2code ADE",
      version: packageJson.version,
    },
    capabilities: {
      // dynamicTools / historyMode / inject_items ride the experimental API.
      experimentalApi: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Experimental `dynamicTools` on thread/start
// ---------------------------------------------------------------------------

export type AdeCodexDynamicToolSpec = EffectCodexSchema.V2ThreadStartParams__DynamicToolSpec;

// TODO: Teach `packages/effect-codex-app-server/scripts/generate.ts` to emit
// experimental fields so the generated `V2ThreadStartParams` includes
// `dynamicTools` directly (same gap as `collaborationMode` on turn/start).
const AdeThreadStartParams = EffectCodexSchema.V2ThreadStartParams.pipe(
  Schema.fieldsAssign({
    dynamicTools: Schema.optionalKey(
      Schema.Array(EffectCodexSchema.V2ThreadStartParams__DynamicToolSpec),
    ),
  }),
);
export type AdeThreadStartParams = typeof AdeThreadStartParams.Type;

const decodeAdeThreadStartParams = Schema.decodeUnknownEffect(AdeThreadStartParams);

/**
 * Minimal projection of `thread/start`'s response for the raw request lane —
 * the adapter only binds thread identity; everything else stays with the
 * generated schemas on the typed lane.
 */
const AdeThreadStartResponseProjection = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
  }),
});
const decodeThreadStartResponse = Schema.decodeUnknownEffect(AdeThreadStartResponseProjection);

// ---------------------------------------------------------------------------
// Tool plane seam (S6 gate plugs in here)
// ---------------------------------------------------------------------------

export interface AdeCodexToolInvocation {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly namespace?: string | null | undefined;
  readonly arguments: unknown;
}

export type AdeCodexToolCallResult = EffectCodexSchema.DynamicToolCallResponse;

/**
 * Handles one dynamic-tool invocation on a registered ADE thread. Attribution
 * is structural: the invocation arrived on the ADE connection for a thread
 * this adapter registered, so {bot, binding} resolve from the session that
 * registered the handler — no credential in the tool plane (spec §3.1).
 */
export type AdeCodexToolCallHandler = (
  invocation: AdeCodexToolInvocation,
) => Effect.Effect<AdeCodexToolCallResult, CodexErrors.CodexAppServerError>;

// ---------------------------------------------------------------------------
// Needs You seam — captured approval / elicitation requests
// ---------------------------------------------------------------------------

export const ADE_CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const;

export type AdeCodexApprovalMethod = (typeof ADE_CODEX_APPROVAL_METHODS)[number];

/**
 * One captured server-side approval/elicitation request. The Codex turn
 * blocks until `respond` is called; the future Needs You inbox owns response
 * timing. `respond` is idempotent — only the first response reaches Codex.
 */
export interface AdeCodexApprovalRequestOf<M extends AdeCodexApprovalMethod> {
  readonly method: M;
  readonly threadId: string;
  readonly params: CodexRpc.ServerRequestParamsByMethod[M];
  readonly respond: (response: CodexRpc.ServerRequestResponsesByMethod[M]) => Effect.Effect<void>;
}

export type AdeCodexApprovalRequest = {
  [M in AdeCodexApprovalMethod]: AdeCodexApprovalRequestOf<M>;
}[AdeCodexApprovalMethod];

export type AdeCodexThreadEvent =
  | {
      readonly _tag: "statusChanged";
      readonly threadId: string;
      readonly status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"];
    }
  | {
      readonly _tag: "approvalRequested";
      readonly request: AdeCodexApprovalRequest;
    };

// ---------------------------------------------------------------------------
// Binding bookkeeping (contracts BotExecutionBinding, spec §2.1)
// ---------------------------------------------------------------------------

/**
 * Kernel-side facts for one ADE-owned Codex thread, shaped for persistence
 * into `ade_bot_execution_bindings`. `forkedFromThreadId` carries fork
 * lineage; the S2 schema keys lineage on assignments, so callers that need
 * durable thread ancestry record it on the assignment side.
 */
export interface AdeCodexBindingDescriptor {
  readonly botId: BotId;
  readonly engine: "codex";
  readonly sessionId: KernelSessionId;
  readonly purpose: BotExecutionBindingPurpose;
  readonly threadSource: string;
  readonly forkedFromThreadId?: string;
}

export const toBotExecutionBinding = (
  descriptor: AdeCodexBindingDescriptor,
  input: {
    readonly id: BotExecutionBindingId;
    readonly status?: BotExecutionBindingStatus;
    readonly now: IsoDateTime;
  },
): BotExecutionBinding => ({
  id: input.id,
  botId: descriptor.botId,
  engine: descriptor.engine,
  sessionId: descriptor.sessionId,
  purpose: descriptor.purpose,
  status: input.status ?? "active",
  createdAt: input.now,
  updatedAt: input.now,
});

// ---------------------------------------------------------------------------
// Session surface
// ---------------------------------------------------------------------------

export interface AdeCodexStartThreadOptions {
  readonly botId: BotId;
  readonly purpose: BotExecutionBindingPurpose;
  readonly cwd: string;
  readonly onToolCall: AdeCodexToolCallHandler;
  readonly dynamicTools?: ReadonlyArray<AdeCodexDynamicToolSpec>;
  readonly model?: string;
  readonly developerInstructions?: string;
  readonly baseInstructions?: string;
  readonly approvalPolicy?: EffectCodexSchema.V2ThreadStartParams["approvalPolicy"];
  readonly sandbox?: EffectCodexSchema.V2ThreadStartParams["sandbox"];
  readonly config?: EffectCodexSchema.V2ThreadStartParams["config"];
  readonly ephemeral?: boolean;
  /** Override the derived `shuv2code/ade/<botId>/<purpose>` source. */
  readonly threadSource?: string;
}

export interface AdeCodexResumeThreadOptions {
  /** Codex thread id recorded in the binding (`BotExecutionBinding.sessionId`). */
  readonly threadId: string;
  readonly botId: BotId;
  readonly purpose: BotExecutionBindingPurpose;
  readonly cwd: string;
  /**
   * Codex restores persisted `dynamicTools` from the rollout on resume; the
   * adapter restores the client-side registration so restored invocations
   * dispatch here again.
   */
  readonly onToolCall: AdeCodexToolCallHandler;
  readonly model?: string;
  readonly developerInstructions?: string;
  readonly approvalPolicy?: EffectCodexSchema.V2ThreadResumeParams["approvalPolicy"];
  readonly sandbox?: EffectCodexSchema.V2ThreadResumeParams["sandbox"];
  readonly config?: EffectCodexSchema.V2ThreadResumeParams["config"];
}

export interface AdeCodexForkThreadOptions {
  readonly botId?: BotId;
  readonly purpose?: BotExecutionBindingPurpose;
  readonly onToolCall?: AdeCodexToolCallHandler;
  readonly model?: string;
  readonly lastTurnId?: string;
}

export interface AdeCodexTurnInput {
  readonly text: string;
  readonly model?: string;
}

export interface AdeCodexSteerInput {
  /** Precondition: the currently active turn. Fails when it no longer is. */
  readonly expectedTurnId: string;
  readonly text: string;
  readonly clientUserMessageId?: string;
}

export interface AdeCodexThreadSession {
  /** Codex thread id — the kernel `sessionId` for binding bookkeeping. */
  readonly threadId: string;
  readonly binding: AdeCodexBindingDescriptor;
  /** Thread-scoped events: status changes + respondable approval requests. */
  readonly events: Stream.Stream<AdeCodexThreadEvent>;
  /** Append raw Responses API items to model-visible history. */
  readonly injectItems: (
    items: ReadonlyArray<Schema.Json>,
  ) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly startTurn: (
    input: AdeCodexTurnInput,
  ) => Effect.Effect<
    CodexRpc.ClientRequestResponsesByMethod["turn/start"],
    CodexErrors.CodexAppServerError
  >;
  /** Redirect the active turn in place. Never interrupts (steer ≠ cancel). */
  readonly steerTurn: (
    input: AdeCodexSteerInput,
  ) => Effect.Effect<
    CodexRpc.ClientRequestResponsesByMethod["turn/steer"],
    CodexErrors.CodexAppServerError
  >;
  /** Cancel one specific turn. Never carries replacement input. */
  readonly interruptTurn: (turnId: string) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
  /** Fork this thread; the child session records `forkedFromThreadId`. */
  readonly fork: (
    options?: AdeCodexForkThreadOptions,
  ) => Effect.Effect<AdeCodexThreadSession, CodexErrors.CodexAppServerError, Scope.Scope>;
}

export interface AdeCodexKernelConnection {
  readonly startThread: (
    options: AdeCodexStartThreadOptions,
  ) => Effect.Effect<AdeCodexThreadSession, CodexErrors.CodexAppServerError, Scope.Scope>;
  readonly resumeThread: (
    options: AdeCodexResumeThreadOptions,
  ) => Effect.Effect<AdeCodexThreadSession, CodexErrors.CodexAppServerError, Scope.Scope>;
  /** Resolves once when the underlying shared-socket connection terminates. */
  readonly terminated: Effect.Effect<CodexErrors.CodexAppServerError>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RegisteredThread {
  readonly onToolCall: AdeCodexToolCallHandler;
  readonly events: Queue.Queue<AdeCodexThreadEvent>;
}

const unknownThreadRequestError = (method: string, threadId: string) =>
  new CodexErrors.CodexAppServerRequestError({
    code: -32603,
    errorMessage: `ADE Codex adapter has no registered session for thread ${threadId}`,
    method,
  });

/**
 * Wrap one issued supervisor connection as the ADE kernel connection:
 * performs the ADE-tagged initialize handshake and installs the thread-keyed
 * dispatchers for dynamic-tool calls, approvals, and status notifications.
 */
export const makeAdeCodexKernelConnection = Effect.fn("makeAdeCodexKernelConnection")(function* (
  connection: CodexAppServerConnection,
): Effect.fn.Return<AdeCodexKernelConnection, CodexErrors.CodexAppServerError, Scope.Scope> {
  const client: CodexClient.CodexAppServerClient["Service"] = connection.client;
  // Thread registry: only threads registered here are ADE-owned. Everything
  // else on this connection (none, by upstream thread-scoped delivery) is
  // dropped, which keeps coexistence with the realtime supervisor safe even
  // if a foreign notification ever leaked onto this connection.
  const threads = new Map<string, RegisteredThread>();

  yield* client.request("initialize", buildAdeCodexInitializeParams());
  yield* client.notify("initialized", undefined);

  yield* client.handleServerRequest("item/tool/call", (params) => {
    const registered = threads.get(params.threadId);
    if (registered === undefined) {
      return Effect.fail(unknownThreadRequestError("item/tool/call", params.threadId));
    }
    return registered.onToolCall({
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      tool: params.tool,
      namespace: params.namespace,
      arguments: params.arguments,
    });
  });

  const registerApprovalMethod = <M extends AdeCodexApprovalMethod>(method: M) =>
    client.handleServerRequest(method, (params) =>
      Effect.gen(function* () {
        const threadId = params.threadId;
        const registered = threads.get(threadId);
        if (registered === undefined) {
          return yield* unknownThreadRequestError(method, threadId);
        }
        const decided = yield* Deferred.make<CodexRpc.ServerRequestResponsesByMethod[M]>();
        const request: AdeCodexApprovalRequestOf<M> = {
          method,
          threadId,
          params,
          respond: (response) => Deferred.succeed(decided, response).pipe(Effect.asVoid),
        };
        yield* Queue.offer(registered.events, {
          _tag: "approvalRequested",
          request: request as unknown as AdeCodexApprovalRequest,
        });
        return yield* Deferred.await(decided);
      }),
    );
  for (const method of ADE_CODEX_APPROVAL_METHODS) {
    yield* registerApprovalMethod(method);
  }

  yield* client.handleServerNotification("thread/status/changed", (params) => {
    const registered = threads.get(params.threadId);
    if (registered === undefined) {
      return Effect.void;
    }
    return Queue.offer(registered.events, {
      _tag: "statusChanged",
      threadId: params.threadId,
      status: params.status,
    }).pipe(Effect.asVoid);
  });

  const registerThread = Effect.fn("AdeCodexKernelConnection.registerThread")(function* (
    threadId: string,
    onToolCall: AdeCodexToolCallHandler,
  ): Effect.fn.Return<RegisteredThread, never, Scope.Scope> {
    const events = yield* Queue.unbounded<AdeCodexThreadEvent>();
    const registered: RegisteredThread = { onToolCall, events };
    threads.set(threadId, registered);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (threads.get(threadId) === registered) {
          threads.delete(threadId);
        }
        yield* Queue.shutdown(events);
      }),
    );
    return registered;
  });

  const makeSession = (
    threadId: string,
    binding: AdeCodexBindingDescriptor,
    registered: RegisteredThread,
  ): AdeCodexThreadSession => ({
    threadId,
    binding,
    events: Stream.fromQueue(registered.events),
    injectItems: (items) =>
      client.request("thread/inject_items", { threadId, items }).pipe(Effect.asVoid),
    startTurn: (input) =>
      client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.text }],
        ...(input.model !== undefined ? { model: input.model } : {}),
      }),
    steerTurn: (input) =>
      client.request("turn/steer", {
        threadId,
        expectedTurnId: input.expectedTurnId,
        input: [{ type: "text", text: input.text }],
        ...(input.clientUserMessageId !== undefined
          ? { clientUserMessageId: input.clientUserMessageId }
          : {}),
      }),
    interruptTurn: (turnId) =>
      client.request("turn/interrupt", { threadId, turnId }).pipe(Effect.asVoid),
    fork: (options = {}) =>
      Effect.gen(function* () {
        const botId = options.botId ?? binding.botId;
        const purpose = options.purpose ?? binding.purpose;
        const threadSource = adeCodexThreadSource(botId, purpose);
        const response = yield* client.request("thread/fork", {
          threadId,
          threadSource,
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.lastTurnId !== undefined ? { lastTurnId: options.lastTurnId } : {}),
        });
        const childThreadId = response.thread.id;
        const childRegistered = yield* registerThread(
          childThreadId,
          options.onToolCall ?? registered.onToolCall,
        );
        const childBinding: AdeCodexBindingDescriptor = {
          botId,
          engine: "codex",
          sessionId: KernelSessionId.make(childThreadId),
          purpose,
          threadSource,
          forkedFromThreadId: threadId,
        };
        return makeSession(childThreadId, childBinding, childRegistered);
      }),
  });

  const startThread: AdeCodexKernelConnection["startThread"] = Effect.fn(
    "AdeCodexKernelConnection.startThread",
  )(function* (options) {
    const threadSource =
      options.threadSource ?? adeCodexThreadSource(options.botId, options.purpose);
    const params = yield* decodeAdeThreadStartParams({
      cwd: options.cwd,
      serviceName: ADE_CODEX_SERVICE_NAME,
      threadSource,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.developerInstructions !== undefined
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.baseInstructions !== undefined
        ? { baseInstructions: options.baseInstructions }
        : {}),
      ...(options.approvalPolicy != null ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandbox != null ? { sandbox: options.sandbox } : {}),
      ...(options.config != null ? { config: options.config } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.dynamicTools !== undefined ? { dynamicTools: options.dynamicTools } : {}),
    }).pipe(
      Effect.mapError((cause) =>
        CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
          "decode-request-payload",
          cause,
          { method: "thread/start" },
        ),
      ),
    );
    // The generated client schema does not know the experimental
    // `dynamicTools` field yet, so the typed request path would strip it;
    // send the schema-validated params over the raw lane instead.
    const rawResponse = yield* client.raw.request("thread/start", params);
    const response = yield* decodeThreadStartResponse(rawResponse).pipe(
      Effect.mapError((cause) =>
        CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
          "decode-response-payload",
          cause,
          { method: "thread/start" },
        ),
      ),
    );
    const threadId = response.thread.id;
    const registered = yield* registerThread(threadId, options.onToolCall);
    const binding: AdeCodexBindingDescriptor = {
      botId: options.botId,
      engine: "codex",
      sessionId: KernelSessionId.make(threadId),
      purpose: options.purpose,
      threadSource,
    };
    return makeSession(threadId, binding, registered);
  });

  const resumeThread: AdeCodexKernelConnection["resumeThread"] = Effect.fn(
    "AdeCodexKernelConnection.resumeThread",
  )(function* (options) {
    const response = yield* client.request("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.developerInstructions !== undefined
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.approvalPolicy != null ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandbox != null ? { sandbox: options.sandbox } : {}),
      ...(options.config != null ? { config: options.config } : {}),
    });
    const threadId = response.thread.id;
    // Codex restored persisted dynamicTools from the rollout; restoring the
    // client-side registration re-attaches invocations to the ADE tool plane.
    const registered = yield* registerThread(threadId, options.onToolCall);
    const binding: AdeCodexBindingDescriptor = {
      botId: options.botId,
      engine: "codex",
      sessionId: KernelSessionId.make(threadId),
      purpose: options.purpose,
      threadSource:
        response.thread.threadSource ?? adeCodexThreadSource(options.botId, options.purpose),
      ...(response.thread.forkedFromId != null
        ? { forkedFromThreadId: response.thread.forkedFromId }
        : {}),
    };
    return makeSession(threadId, binding, registered);
  });

  return {
    startThread,
    resumeThread,
    terminated: connection.terminated,
  } satisfies AdeCodexKernelConnection;
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdeCodexKernelAdapter extends Context.Service<
  AdeCodexKernelAdapter,
  {
    /**
     * Open one ADE connection to the supervised shared app-server for `key`.
     * Fails closed under `per-session` topology — ADE requires the shared
     * supervisor (ADR §10.2).
     */
    readonly connect: (
      key: CodexAppServerSupervisorKey,
    ) => Effect.Effect<AdeCodexKernelConnection, CodexErrors.CodexAppServerError, Scope.Scope>;
  }
>()("shuv2code/ade/AdeCodexKernelAdapter") {
  static readonly layer = Layer.effect(
    AdeCodexKernelAdapter,
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      return AdeCodexKernelAdapter.of({
        connect: Effect.fn("AdeCodexKernelAdapter.connect")(function* (key) {
          const connection = yield* supervisor.acquireConnection(key);
          return yield* makeAdeCodexKernelConnection(connection);
        }),
      });
    }),
  );
}
