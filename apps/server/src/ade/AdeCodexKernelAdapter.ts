/**
 * ADE-facing Codex kernel adapter (spec `docs/ade/ADE-V1-SPEC.md` §3.3).
 *
 * Binds ADE bot sessions to the shared supervised Codex app-server
 * (`CodexAppServerSupervisor`) over one dedicated ADE connection per
 * supervisor key (`connect` memoizes per key for the life of the service
 * and re-acquires after a connection terminates). The adapter owns:
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
 * is structural in V1: codex chmods the unix control socket itself to 0600
 * (upstream `app-server-transport/src/transport/unix_socket.rs`,
 * `CONTROL_SOCKET_MODE`) and the supervisor creates the socket directory with
 * mode 0700 under the server runtime dir — `--ws-auth` applies only to
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
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import packageJson from "../../package.json" with { type: "json" };
import { codexAppServerSupervisorKey } from "../provider/Layers/codexLaunchArgs.ts";
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

/**
 * Fail-closed responses. Every approval-family request has a safe "grant
 * nothing" answer: declines for approvals/elicitations, an empty grant for
 * permissions, no answers for user-input questions.
 */
const APPROVAL_DECLINE_RESPONSES: {
  readonly [M in AdeCodexApprovalMethod]: CodexRpc.ServerRequestResponsesByMethod[M];
} = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {} },
  "item/tool/requestUserInput": { answers: {} },
  "mcpServer/elicitation/request": { action: "decline" },
};

const declineResponseFor = <M extends AdeCodexApprovalMethod>(
  method: M,
): CodexRpc.ServerRequestResponsesByMethod[M] =>
  // Indexed access through the mapped-type map loses the per-M correlation
  // for a generic M; the map itself is keyed and typed per method above.
  APPROVAL_DECLINE_RESPONSES[method] as CodexRpc.ServerRequestResponsesByMethod[M];

/**
 * Bound on how long one approval may keep a server request pending. The
 * request handler runs on its own fiber (transport forks incoming request
 * dispatch), but codex still holds the turn open until it gets an answer —
 * an unbounded await would wedge that thread forever if the consumer never
 * responds. On timeout the adapter declines and emits `approvalTimedOut`.
 */
export const ADE_CODEX_APPROVAL_TIMEOUT_DEFAULT = "10 minutes" as const;

export type AdeCodexThreadEvent =
  | {
      readonly _tag: "statusChanged";
      readonly threadId: string;
      readonly status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"];
    }
  | {
      readonly _tag: "approvalRequested";
      readonly request: AdeCodexApprovalRequest;
    }
  | {
      /** The adapter declined `method` after the approval deadline expired. */
      readonly _tag: "approvalTimedOut";
      readonly threadId: string;
      readonly method: AdeCodexApprovalMethod;
    }
  | {
      /**
       * The shared-supervisor connection died. Pending approvals were settled
       * as declined; the session's event stream ends after this event and the
       * session must be re-established via `resumeThread` on a fresh
       * connection.
       */
      readonly _tag: "connectionTerminated";
      readonly threadId: string;
      readonly error: CodexErrors.CodexAppServerError;
    };

/** `ephemeral` threads have no rollout, so dynamicTools can never be restored
 * on resume — the combination silently breaks restart recovery (spec §3.1). */
export class AdeCodexEphemeralDynamicToolsError extends Schema.TaggedErrorClass<AdeCodexEphemeralDynamicToolsError>()(
  "AdeCodexEphemeralDynamicToolsError",
  {
    botId: Schema.String,
  },
) {
  override get message(): string {
    return `Ephemeral Codex threads cannot carry dynamicTools (no rollout to restore them from on resume); bot ${this.botId}.`;
  }
}

export type AdeCodexKernelError =
  | CodexErrors.CodexAppServerError
  | AdeCodexEphemeralDynamicToolsError;

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
  // Summaries are recorded at retirement by the session/rollover service
  // (S8); a freshly described kernel session never carries one.
  rolloverSummary: null,
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
  ) => Effect.Effect<AdeCodexThreadSession, AdeCodexKernelError, Scope.Scope>;
  readonly resumeThread: (
    options: AdeCodexResumeThreadOptions,
  ) => Effect.Effect<AdeCodexThreadSession, CodexErrors.CodexAppServerError, Scope.Scope>;
  /** Resolves once when the underlying shared-socket connection terminates. */
  readonly terminated: Effect.Effect<CodexErrors.CodexAppServerError>;
}

export interface MakeAdeCodexKernelConnectionOptions {
  /** Deadline for pending approvals; defaults to {@link ADE_CODEX_APPROVAL_TIMEOUT_DEFAULT}. */
  readonly approvalTimeout?: Duration.Input;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingApproval {
  readonly method: AdeCodexApprovalMethod;
  /** Idempotently settles the awaiting request handler with a decline. */
  readonly settleDeclined: Effect.Effect<void>;
}

interface RegisteredThread {
  readonly onToolCall: AdeCodexToolCallHandler;
  readonly events: Queue.Queue<AdeCodexThreadEvent, Cause.Done>;
  readonly pendingApprovals: Set<PendingApproval>;
}

const unknownThreadRequestError = (method: string, threadId: string) =>
  new CodexErrors.CodexAppServerRequestError({
    code: -32603,
    errorMessage: `ADE Codex adapter has no registered session for thread ${threadId}`,
    method,
  });

const settlePendingApprovals = (registered: RegisteredThread): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const pending of registered.pendingApprovals) {
      yield* pending.settleDeclined;
    }
    registered.pendingApprovals.clear();
  });

/**
 * Wrap one issued supervisor connection as the ADE kernel connection:
 * performs the ADE-tagged initialize handshake and installs the thread-keyed
 * dispatchers for dynamic-tool calls, approvals, and status notifications.
 */
export const makeAdeCodexKernelConnection = Effect.fn("makeAdeCodexKernelConnection")(function* (
  connection: CodexAppServerConnection,
  options: MakeAdeCodexKernelConnectionOptions = {},
): Effect.fn.Return<AdeCodexKernelConnection, CodexErrors.CodexAppServerError, Scope.Scope> {
  const client: CodexClient.CodexAppServerClient["Service"] = connection.client;
  const approvalTimeout = options.approvalTimeout ?? ADE_CODEX_APPROVAL_TIMEOUT_DEFAULT;
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
        const decline = declineResponseFor(method);
        const decided = yield* Deferred.make<CodexRpc.ServerRequestResponsesByMethod[M]>();
        const pending: PendingApproval = {
          method,
          settleDeclined: Deferred.succeed(decided, decline).pipe(Effect.asVoid),
        };
        registered.pendingApprovals.add(pending);
        const request: AdeCodexApprovalRequestOf<M> = {
          method,
          threadId,
          params,
          respond: (response) => Deferred.succeed(decided, response).pipe(Effect.asVoid),
        };
        const offered = yield* Queue.offer(registered.events, {
          _tag: "approvalRequested",
          request: request as unknown as AdeCodexApprovalRequest,
        });
        if (!offered) {
          // The session tore down between the registry lookup and the offer:
          // nobody will ever see this request, so fail closed immediately
          // instead of awaiting a response that cannot come.
          registered.pendingApprovals.delete(pending);
          return decline;
        }
        // Bounded await: a consumer that never answers must not hold the
        // codex turn (and this pending request) open forever.
        const response = yield* Deferred.await(decided).pipe(Effect.timeoutOption(approvalTimeout));
        registered.pendingApprovals.delete(pending);
        if (Option.isSome(response)) {
          return response.value;
        }
        // Settle so a late respond() becomes a no-op, tell the consumer, and
        // decline to codex.
        yield* pending.settleDeclined;
        yield* Queue.offer(registered.events, {
          _tag: "approvalTimedOut",
          threadId,
          method,
        });
        return decline;
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

  const deregisterThread = (registered: RegisteredThread): void => {
    for (const [key, value] of threads) {
      if (value === registered) {
        threads.delete(key);
      }
    }
  };

  const registerThread = Effect.fn("AdeCodexKernelConnection.registerThread")(function* (
    threadId: string,
    onToolCall: AdeCodexToolCallHandler,
  ): Effect.fn.Return<RegisteredThread, never, Scope.Scope> {
    const events = yield* Queue.unbounded<AdeCodexThreadEvent, Cause.Done>();
    const registered: RegisteredThread = { onToolCall, events, pendingApprovals: new Set() };
    threads.set(threadId, registered);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        deregisterThread(registered);
        // Settle before ending the queue: an approval handler blocked on
        // its Deferred must resolve (as a decline back to codex), never leak.
        yield* settlePendingApprovals(registered);
        // End (not shutdown): buffered events stay drainable, then the
        // session's event stream completes.
        yield* Queue.end(events);
      }),
    );
    return registered;
  });

  // Supervisor-connection death is terminal for every session on it: settle
  // pending approvals, emit a fail-loud terminal event, and end each stream so
  // callers observe the loss instead of a session that looks alive forever.
  yield* connection.terminated.pipe(
    Effect.flatMap((error) =>
      Effect.gen(function* () {
        const registeredThreads = Array.from(threads.entries());
        threads.clear();
        for (const [threadId, registered] of registeredThreads) {
          yield* settlePendingApprovals(registered);
          yield* Queue.offer(registered.events, {
            _tag: "connectionTerminated",
            threadId,
            error,
          });
          yield* Queue.end(registered.events);
        }
      }),
    ),
    Effect.forkScoped,
  );

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
        // Unlike resume, registration after the response is race-free here:
        // the forked thread did not exist before this call, so codex has no
        // pending server requests to replay for it.
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
    if (options.ephemeral === true && (options.dynamicTools?.length ?? 0) > 0) {
      return yield* new AdeCodexEphemeralDynamicToolsError({ botId: options.botId });
    }
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
    // Register BEFORE issuing thread/resume: codex replays pending server
    // requests (approvals, tool calls) immediately after the resume response,
    // and registering afterwards would race that replay straight into the
    // fail-closed unknown-thread path — corrupting exactly the restart
    // recovery this resume exists for. Codex restores persisted dynamicTools
    // from the rollout; this registration re-attaches their invocations to
    // the ADE tool plane.
    const registered = yield* registerThread(options.threadId, options.onToolCall);
    const response = yield* client
      .request("thread/resume", {
        threadId: options.threadId,
        cwd: options.cwd,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.developerInstructions !== undefined
          ? { developerInstructions: options.developerInstructions }
          : {}),
        ...(options.approvalPolicy != null ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandbox != null ? { sandbox: options.sandbox } : {}),
        ...(options.config != null ? { config: options.config } : {}),
      })
      .pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            // Failed resume: drop the eager registration now instead of
            // waiting for the caller scope to close.
            deregisterThread(registered);
          }),
        ),
      );
    const threadId = response.thread.id;
    if (threadId !== options.threadId) {
      // Defensive: re-key the registration if codex resolves the resume to a
      // different thread identity. The scope finalizer deregisters by value,
      // so the moved entry stays covered.
      deregisterThread(registered);
      threads.set(threadId, registered);
    }
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
     * The ADE connection to the supervised shared app-server for `key`:
     * memoized per supervisor identity for the life of the service, dropped
     * (and re-acquired on the next call) once its transport terminates.
     * Fails closed under `per-session` topology — ADE requires the shared
     * supervisor (ADR §10.2).
     */
    readonly connect: (
      key: CodexAppServerSupervisorKey,
    ) => Effect.Effect<AdeCodexKernelConnection, CodexErrors.CodexAppServerError>;
  }
>()("shuv2code/ade/AdeCodexKernelAdapter") {
  static readonly layer = Layer.effect(
    AdeCodexKernelAdapter,
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      // Layer construction scope: memoized connections live as long as the
      // adapter service itself.
      const layerScope = yield* Scope.Scope;
      const connections = new Map<string, AdeCodexKernelConnection>();
      // Per-digest lanes: only concurrent connects for the SAME identity must
      // serialize (to avoid a double connection). Plain-sync map access
      // between yields is atomic under Effect's single-threaded runtime.
      const connectLanes = new Map<string, Semaphore.Semaphore>();
      const laneFor = (digest: string): Semaphore.Semaphore => {
        const existing = connectLanes.get(digest);
        if (existing !== undefined) return existing;
        const lane = Semaphore.makeUnsafe(1);
        connectLanes.set(digest, lane);
        return lane;
      };
      return AdeCodexKernelAdapter.of({
        connect: Effect.fn("AdeCodexKernelAdapter.connect")(function* (key) {
          const digest = codexAppServerSupervisorKey({
            binaryPath: key.binaryPath,
            codexHome: key.codexHome,
            launchArgs: key.launchArgs,
            enableRealtimeConversation: supervisor.sharedRealtimeEnabled,
          });
          return yield* laneFor(digest).withPermits(1)(
            Effect.gen(function* () {
              const existing = connections.get(digest);
              if (existing !== undefined) {
                return existing;
              }
              const kernel = yield* supervisor.acquireConnection(key).pipe(
                Effect.flatMap((connection) => makeAdeCodexKernelConnection(connection)),
                Effect.provideService(Scope.Scope, layerScope),
              );
              connections.set(digest, kernel);
              // A dead connection must never be handed out again.
              yield* kernel.terminated.pipe(
                Effect.flatMap(() =>
                  Effect.sync(() => {
                    if (connections.get(digest) === kernel) {
                      connections.delete(digest);
                    }
                  }),
                ),
                Effect.forkIn(layerScope),
              );
              return kernel;
            }),
          );
        }),
      });
    }),
  );
}
