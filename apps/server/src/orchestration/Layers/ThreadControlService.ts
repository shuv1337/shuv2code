import {
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationThread,
  type ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type TurnId,
} from "@shuv2code/contracts";
import { stableStringify } from "@shuv2code/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type {
  ThreadControlContextAnchor,
  ThreadControlUntrustedContextRequest,
} from "../Services/ThreadControlService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ThreadControlGrant } from "../Services/ThreadControlInvocationResolver.ts";
import {
  ThreadControlError,
  ThreadControlService,
  type ControllerActionContext,
  type ThreadControlAuthorization,
  type ThreadControlMutationResult,
  type ThreadControlPhase,
  type ThreadControlThreadSummary,
} from "../Services/ThreadControlService.ts";

const TARGET_CONTEXT_MAX_MESSAGES = 12;
const TARGET_CONTEXT_MAX_CHARS = 12_000;
const TARGET_CONTEXT_MAX_MESSAGE_CHARS = 4_000;

export interface UntrustedContextLimits {
  readonly maxMessages: number;
  readonly maxTotalChars: number;
  readonly maxMessageChars: number;
  readonly anchor: ThreadControlContextAnchor;
}

const BOUNDED_CONTEXT_DEFAULTS: Omit<UntrustedContextLimits, "anchor"> = {
  maxMessages: 12,
  maxTotalChars: 12_000,
  maxMessageChars: 4_000,
};

const FULL_CONTEXT_CEILINGS: Omit<UntrustedContextLimits, "anchor"> = {
  maxMessages: 10_000,
  maxTotalChars: 1_000_000,
  maxMessageChars: 100_000,
};

const clampLimit = (value: number, ceiling: number): number =>
  Math.min(Math.max(Math.floor(value), 1), ceiling);

export function resolveUntrustedContextLimits(
  request: ThreadControlUntrustedContextRequest | undefined,
): UntrustedContextLimits {
  const defaults = request?.mode === "full" ? FULL_CONTEXT_CEILINGS : BOUNDED_CONTEXT_DEFAULTS;
  const anchor = request?.anchor ?? "recent";
  if (request?.maxMessages === undefined && request?.maxTotalChars === undefined) {
    return {
      maxMessages:
        request?.maxMessages === undefined
          ? defaults.maxMessages
          : clampLimit(request.maxMessages, FULL_CONTEXT_CEILINGS.maxMessages),
      maxTotalChars: defaults.maxTotalChars,
      maxMessageChars:
        request?.maxMessageChars === undefined
          ? defaults.maxMessageChars
          : clampLimit(request.maxMessageChars, FULL_CONTEXT_CEILINGS.maxMessageChars),
      anchor,
    };
  }
  return {
    maxMessages:
      request.maxMessages === undefined
        ? defaults.maxMessages
        : clampLimit(request.maxMessages, FULL_CONTEXT_CEILINGS.maxMessages),
    maxTotalChars:
      request.maxTotalChars === undefined
        ? defaults.maxTotalChars
        : clampLimit(request.maxTotalChars, FULL_CONTEXT_CEILINGS.maxTotalChars),
    maxMessageChars:
      request.maxMessageChars === undefined
        ? defaults.maxMessageChars
        : clampLimit(request.maxMessageChars, FULL_CONTEXT_CEILINGS.maxMessageChars),
    anchor,
  };
}

export function untrustedThreadContext(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean;
  }>,
  limits: UntrustedContextLimits,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> {
  const selected: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
  let remaining = limits.maxTotalChars;
  const ordered = limits.anchor === "oldest" ? messages : [...messages].reverse();
  for (const message of ordered) {
    if (selected.length >= limits.maxMessages || remaining <= 0) break;
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      message.streaming === true
    ) {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0) continue;
    const bounded = text.slice(0, Math.min(limits.maxMessageChars, remaining));
    if (bounded.length === 0) continue;
    if (limits.anchor === "oldest") {
      selected.push({ role: message.role, text: bounded });
    } else {
      selected.unshift({ role: message.role, text: bounded });
    }
    remaining -= bounded.length;
  }
  return selected;
}

export function boundedUntrustedThreadContext(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean;
  }>,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> {
  const selected: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
  let remaining = TARGET_CONTEXT_MAX_CHARS;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < TARGET_CONTEXT_MAX_MESSAGES;
    index -= 1
  ) {
    const message = messages[index];
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      message.streaming === true
    ) {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0 || remaining === 0) continue;
    const bounded = text.slice(0, Math.min(TARGET_CONTEXT_MAX_MESSAGE_CHARS, remaining));
    selected.unshift({ role: message.role, text: bounded });
    remaining -= bounded.length;
  }
  return selected;
}

const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export function isAvailableThreadControlSource(
  thread: Pick<OrchestrationThread, "purpose" | "deletedAt" | "archivedAt">,
): boolean {
  return (
    thread.purpose !== "voice-transport" && thread.deletedAt === null && thread.archivedAt === null
  );
}

export interface ControllerCreateModelCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: {
    readonly enabled: boolean;
    readonly availability?: "available" | "unavailable" | undefined;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  };
}

export function resolveControllerCreateModelSelection(input: {
  readonly requestedModel: string | undefined;
  readonly controllerModel: ModelSelection;
  readonly candidates: ReadonlyArray<ControllerCreateModelCandidate>;
}): ModelSelection {
  if (input.requestedModel === undefined || input.requestedModel === input.controllerModel.model) {
    return input.controllerModel;
  }
  const match = input.candidates.find((candidate) => {
    if (!candidate.snapshot.enabled) return false;
    if (candidate.snapshot.availability === "unavailable") return false;
    return candidate.snapshot.models.some((model) => model.slug === input.requestedModel);
  });
  if (match === undefined) {
    throw new ThreadControlError({
      code: "invalid_model",
      message: `No available provider instance advertises model "${input.requestedModel}".`,
    });
  }
  return ModelSelection.make({
    instanceId: match.instanceId,
    model: input.requestedModel,
  });
}

function shellPhaseOf(thread: OrchestrationThreadShell): ThreadControlPhase {
  const session = thread.session;
  const latestTurn = thread.latestTurn;
  const terminal =
    session === null ||
    session.status === "ready" ||
    session.status === "stopped" ||
    session.status === "error" ||
    session.status === "interrupted" ||
    latestTurn?.state === "completed" ||
    latestTurn?.state === "interrupted" ||
    latestTurn?.state === "error";
  if (!terminal && thread.hasPendingApprovals) return "waiting_for_approval";
  if (!terminal && thread.hasPendingUserInput) return "waiting_for_input";
  if (session?.status === "error" || latestTurn?.state === "error") return "failed";
  if (session?.status === "starting") return "starting";
  if (session?.status === "running" || latestTurn?.state === "running") return "working";
  if (session?.status === "interrupted" || latestTurn?.state === "interrupted") {
    return "interrupted";
  }
  if (latestTurn?.state === "completed") return "completed";
  if (session?.status === "ready" || session?.status === "idle") return "ready";
  return "stopped";
}

function summarizeThread(thread: OrchestrationThreadShell): ThreadControlThreadSummary {
  const phase = shellPhaseOf(thread);
  const terminal =
    phase === "failed" ||
    phase === "interrupted" ||
    phase === "completed" ||
    phase === "ready" ||
    phase === "stopped";
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    phase,
    activeTurnId: terminal ? null : (thread.session?.activeTurnId ?? null),
    hasPendingApproval: !terminal && thread.hasPendingApprovals,
    hasPendingUserInput: !terminal && thread.hasPendingUserInput,
    latestTurnUpdatedAt: thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt ?? null,
  };
}

function operationId(action: ControllerActionContext, operation: string): string {
  return `${action.operationIdPrefix}:${operation}`;
}

function commandId(action: ControllerActionContext, operation: string): CommandId {
  return CommandId.make(operationId(action, operation));
}

function messageId(action: ControllerActionContext, operation: string): MessageId {
  return MessageId.make(`${operationId(action, operation)}:message`);
}

function requireNonEmpty(value: string, field: string): Effect.Effect<string, ThreadControlError> {
  const trimmed = value.trim();
  return trimmed.length === 0
    ? Effect.fail(
        new ThreadControlError({
          code: "invalid_input",
          message: `${field} must not be empty.`,
        }),
      )
    : Effect.succeed(trimmed);
}

export const validateSendTargetPrecondition = (input: {
  readonly disposition: "start" | "steer";
  readonly expectedTurnId: TurnId | null;
  readonly currentTurnId: TurnId | null;
  readonly targetRuntimeMode: RuntimeMode;
  readonly runtimeCeiling: RuntimeMode;
}): Effect.Effect<void, ThreadControlError> => {
  if (RUNTIME_MODE_RANK[input.targetRuntimeMode] > RUNTIME_MODE_RANK[input.runtimeCeiling]) {
    return Effect.fail(
      new ThreadControlError({
        code: "runtime_ceiling_exceeded",
        message: "The target runtime mode exceeds the controller ceiling.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  if (input.disposition === "start" && input.currentTurnId !== null) {
    return Effect.fail(
      new ThreadControlError({
        code: "expected_idle",
        message: "The target has an active turn.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  if (input.disposition === "steer" && input.currentTurnId !== input.expectedTurnId) {
    return Effect.fail(
      new ThreadControlError({
        code: "stale_target",
        message: "The target active turn changed before steering.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  return Effect.void;
};

export const validateInterruptTargetPrecondition = (input: {
  readonly expectedTurnId: TurnId;
  readonly currentTurnId: TurnId | null;
}): Effect.Effect<void, ThreadControlError> => {
  if (input.currentTurnId === null) {
    return Effect.fail(
      new ThreadControlError({
        code: "already_terminal",
        message: "The target turn is already terminal.",
        currentTurnId: null,
      }),
    );
  }
  if (input.currentTurnId !== input.expectedTurnId) {
    return Effect.fail(
      new ThreadControlError({
        code: "stale_target",
        message: "The target active turn changed before interruption.",
        currentTurnId: input.currentTurnId,
      }),
    );
  }
  return Effect.void;
};

export const makeThreadControlService = Effect.fn("ThreadControlService.make")(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const providerInstances = yield* ProviderInstanceRegistry;

  const getManagedThread = Effect.fn("ThreadControlService.getManagedThread")(function* (
    grant: ThreadControlGrant,
    threadId: ThreadId,
  ) {
    const authorization = grant.authorization;
    if (threadId === authorization.controllerThreadId) {
      return yield* new ThreadControlError({
        code: "controller_target_forbidden",
        message: "A controller thread cannot target itself.",
      });
    }
    const snapshot = yield* projection.getThreadDetailSnapshot(threadId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The target projection could not be read.",
          }),
      ),
    );
    if (Option.isNone(snapshot)) {
      yield* grant.execution.clearActiveTargetIfMatching(authorization, threadId);
      return yield* new ThreadControlError({
        code: "thread_not_found",
        message: "The target thread was not found.",
      });
    }
    if (snapshot.value.thread.purpose !== "standard") {
      return yield* new ThreadControlError({
        code: "controller_target_forbidden",
        message: "Controller threads may target only standard threads.",
      });
    }
    if (snapshot.value.thread.deletedAt !== null || snapshot.value.thread.archivedAt !== null) {
      yield* grant.execution.clearActiveTargetIfMatching(authorization, threadId);
      return yield* new ThreadControlError({
        code: "thread_archived",
        message: "The target thread is deleted or archived.",
      });
    }
    return snapshot.value;
  });

  const getEffectiveRuntimeCeiling = Effect.fn("ThreadControlService.getEffectiveRuntimeCeiling")(
    function* (authorization: ThreadControlAuthorization) {
      const controller = yield* projection
        .getThreadDetailById(authorization.controllerThreadId)
        .pipe(
          Effect.mapError(
            () =>
              new ThreadControlError({
                code: "controller_mismatch",
                message: "The live controller runtime mode could not be read.",
              }),
          ),
        );
      if (Option.isNone(controller) || !isAvailableThreadControlSource(controller.value)) {
        return yield* new ThreadControlError({
          code: "controller_mismatch",
          message: "The designated controller thread is unavailable.",
        });
      }
      return RUNTIME_MODE_RANK[authorization.authorizedRuntimeCeiling] <=
        RUNTIME_MODE_RANK[controller.value.runtimeMode]
        ? authorization.authorizedRuntimeCeiling
        : controller.value.runtimeMode;
    },
  );

  const dispatch = <A extends Parameters<typeof engine.dispatch>[0]>(
    command: A,
    action: ControllerActionContext,
    authorization: ThreadControlAuthorization,
    provenance: {
      readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
      readonly operation: string;
      readonly canonicalRequestHash: string;
    },
  ): Effect.Effect<{ sequence: number }, ThreadControlError> =>
    engine
      .dispatch(command, {
        actorProvenance: {
          ...action.actorProvenance,
          providerInstanceId: authorization.providerInstanceId,
          toolName: provenance.toolName,
          operation: provenance.operation,
          canonicalRequestHash: provenance.canonicalRequestHash,
        },
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The thread command was not accepted.",
            }),
        ),
      );

  /**
   * Claims the action's single semantic mutation, fences it against the live
   * binding/epoch, persists the dispatch boundary, and replays an exact prior
   * result without issuing another orchestration command.
   */
  const executeMutation = <A extends ThreadControlMutationResult>(input: {
    readonly grant: ThreadControlGrant;
    readonly action: ControllerActionContext;
    readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
    readonly operation: string;
    readonly semanticSlot: string;
    readonly targetThreadId: ThreadId;
    readonly canonicalRequest: string;
    readonly providerCreationId: string | null;
    readonly preDispatch?: Effect.Effect<void, ThreadControlError>;
    readonly effect: (provenance: {
      readonly toolName: "thread_create" | "thread_send" | "thread_interrupt";
      readonly operation: string;
      readonly canonicalRequestHash: string;
    }) => Effect.Effect<A, ThreadControlError>;
  }): Effect.Effect<A, ThreadControlError> => {
    const { grant, effect, preDispatch, ...mutation } = input;
    return grant.execution.execute({
      ...mutation,
      authorization: grant.authorization,
      revalidate: Effect.gen(function* () {
        yield* grant.verifier.authorize(grant.authorization, "control");
        yield* grant.verifier.validateMutation(grant.authorization, input.action);
        if (preDispatch !== undefined) {
          yield* preDispatch;
        }
      }),
      dispatch: effect,
    });
  };

  const list: ThreadControlService["Service"]["list"] = Effect.fn("ThreadControlService.list")(
    function* (input) {
      yield* input.grant.verifier.authorize(input.grant.authorization, "read");
      const snapshot = yield* projection.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The thread inventory could not be read.",
            }),
        ),
      );
      const query = input.projectQuery?.trim().toLocaleLowerCase();
      const projects = snapshot.projects
        .filter(
          (project) => query === undefined || project.title.toLocaleLowerCase().includes(query),
        )
        .map((project) => ({
          projectId: project.id,
          title: project.title,
          ...(project.repositoryIdentity !== null && project.repositoryIdentity !== undefined
            ? { repositoryIdentity: project.repositoryIdentity.canonicalKey }
            : {}),
          defaultModelSelection: project.defaultModelSelection,
        }));
      const projectIds = new Set(projects.map((project) => project.projectId));
      const matchingThreads = snapshot.threads
        .filter(
          (thread) =>
            thread.purpose === "standard" &&
            projectIds.has(thread.projectId) &&
            (input.phase === undefined || shellPhaseOf(thread) === input.phase),
        )
        .map(summarizeThread);
      const cursor = Math.max(0, input.cursor ?? 0);
      const threads = matchingThreads.slice(cursor, cursor + 50);
      return {
        snapshotSequence: snapshot.snapshotSequence,
        projects,
        threads,
        nextCursor:
          cursor + threads.length < matchingThreads.length ? cursor + threads.length : null,
      };
    },
  );

  const get: ThreadControlService["Service"]["get"] = Effect.fn("ThreadControlService.get")(
    function* (input) {
      const authorization = input.grant.authorization;
      yield* input.grant.verifier.authorize(authorization, "read");
      const snapshot = yield* getManagedThread(input.grant, input.threadId);
      const thread = snapshot.thread;
      const shell = yield* projection.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          () =>
            new ThreadControlError({
              code: "dispatch_failed",
              message: "The target shell projection could not be read.",
            }),
        ),
      );
      if (Option.isNone(shell)) {
        return yield* new ThreadControlError({
          code: "thread_not_found",
          message: "The target thread was not found.",
        });
      }
      yield* input.grant.execution.setActiveTarget(authorization, input.threadId);
      const shellSummary = summarizeThread(shell.value);
      const latestAssistant = thread.messages.findLast(
        (candidate) => candidate.role === "assistant" && !candidate.streaming,
      );
      const contextLimits = resolveUntrustedContextLimits(input.untrustedContextRequest);
      const recentContext = untrustedThreadContext(thread.messages, contextLimits);
      return {
        snapshotSequence: snapshot.snapshotSequence,
        snapshotTimestamp: thread.updatedAt,
        thread: shellSummary,
        latestTurnState: thread.latestTurn?.state ?? null,
        lastErrorCode: thread.session?.lastError === null ? null : "provider_error",
        resultCount: thread.messages.filter((message) => message.role === "assistant").length,
        activityCount: thread.activities.length,
        ...(input.includeUntrustedExcerpt === true && latestAssistant !== undefined
          ? {
              untrustedTargetContent: {
                marker: "untrusted-target-content" as const,
                text: latestAssistant.text.slice(0, contextLimits.maxMessageChars),
              },
            }
          : {}),
        ...(input.includeUntrustedContext === true
          ? {
              untrustedTargetContext: {
                marker: "untrusted-target-context" as const,
                messages: recentContext,
              },
            }
          : {}),
      };
    },
  );

  const create: ThreadControlService["Service"]["create"] = Effect.fn(
    "ThreadControlService.create",
  )(function* (input) {
    const authorization = input.grant.authorization;
    yield* input.grant.verifier.authorize(authorization, "control");
    yield* input.grant.verifier.validateMutation(authorization, input.action);
    const instruction = yield* requireNonEmpty(input.initialInstruction, "initialInstruction");
    const project = yield* projection.getProjectShellById(input.projectId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The project projection could not be read.",
          }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* new ThreadControlError({
        code: "project_not_found",
        message: "The target project was not found.",
      });
    }
    const controller = yield* projection.getThreadDetailById(authorization.controllerThreadId).pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            code: "dispatch_failed",
            message: "The controller projection could not be read.",
          }),
      ),
    );
    if (Option.isNone(controller) || !isAvailableThreadControlSource(controller.value)) {
      return yield* new ThreadControlError({
        code: "controller_mismatch",
        message: "The designated controller thread is unavailable.",
      });
    }
    const baseModel = controller.value.modelSelection;
    if (baseModel.instanceId !== authorization.providerInstanceId) {
      return yield* new ThreadControlError({
        code: "invalid_model",
        message: "The controller model is not on its bound provider instance.",
      });
    }
    const registryInstances = yield* providerInstances.listInstances;
    const candidates: ControllerCreateModelCandidate[] = [];
    for (const instance of registryInstances) {
      if (!instance.enabled) continue;
      candidates.push({
        instanceId: instance.instanceId,
        snapshot: yield* instance.snapshot.getSnapshot,
      });
    }
    const modelSelection = yield* Effect.try({
      try: () =>
        resolveControllerCreateModelSelection({
          requestedModel: input.model,
          controllerModel: baseModel,
          candidates,
        }),
      catch: (error) =>
        typeof error === "object" && error !== null && "code" in error
          ? (error as ThreadControlError)
          : new ThreadControlError({
              code: "dispatch_failed",
              message: "The requested model could not be resolved.",
            }),
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const threadId = input.action.createdThreadId;
    const mode =
      RUNTIME_MODE_RANK[authorization.authorizedRuntimeCeiling] <=
      RUNTIME_MODE_RANK[controller.value.runtimeMode]
        ? authorization.authorizedRuntimeCeiling
        : controller.value.runtimeMode;
    const providerCreationId = input.action.providerCreationId;
    return yield* executeMutation({
      grant: input.grant,
      action: input.action,
      toolName: "thread_create",
      // Provider effect acknowledgement belongs to the initial turn start,
      // not the preceding local thread.create event.
      operation: "create-start",
      semanticSlot: `create:${input.projectId}`,
      targetThreadId: threadId,
      providerCreationId,
      canonicalRequest: stableStringify([
        "thread_create",
        input.projectId,
        instruction,
        input.title?.trim() || "",
        modelSelection,
        mode,
      ]),
      effect: (provenance) =>
        Effect.gen(function* () {
          const createResult = yield* dispatch(
            {
              type: "thread.create",
              commandId: commandId(input.action, "create"),
              threadId,
              projectId: input.projectId,
              purpose: "standard",
              title: input.title?.trim() || instruction.slice(0, 80),
              modelSelection,
              runtimeMode: mode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
            input.action,
            authorization,
            provenance,
          );
          const startResult = yield* dispatch(
            {
              type: "thread.turn.start",
              commandId: commandId(input.action, "create-start"),
              threadId,
              message: {
                messageId: messageId(input.action, "create-start"),
                role: "user",
                text: instruction,
                attachments: [],
              },
              modelSelection,
              runtimeMode: mode,
              interactionMode: "default",
              expectedTurnId: null,
              providerRecoveryPolicy: "forbid",
              providerThreadSource: `shuv2code/${providerCreationId}`,
              createdAt,
            },
            input.action,
            authorization,
            provenance,
          );
          return {
            actionId: input.action.actionId,
            operationId: operationId(input.action, "create-start"),
            targetThreadId: threadId,
            disposition: "create" as const,
            expectedTurnId: null,
            acceptedTurnId: null,
            acceptedProjectionSequence: Math.max(createResult.sequence, startResult.sequence),
            providerConfirmation: "pending" as const,
          };
        }),
    });
  });

  const send: ThreadControlService["Service"]["send"] = Effect.fn("ThreadControlService.send")(
    function* (input) {
      const authorization = input.grant.authorization;
      yield* input.grant.verifier.authorize(authorization, "control");
      yield* input.grant.verifier.validateMutation(authorization, input.action);
      const text = yield* requireNonEmpty(input.text, "text");
      const target = yield* getManagedThread(input.grant, input.threadId);
      const currentCeiling = yield* getEffectiveRuntimeCeiling(authorization);
      const currentTurnId = target.thread.session?.activeTurnId ?? null;
      yield* validateSendTargetPrecondition({
        disposition: input.disposition,
        expectedTurnId: input.expectedTurnId,
        currentTurnId,
        targetRuntimeMode: target.thread.runtimeMode,
        runtimeCeiling: currentCeiling,
      });
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return yield* executeMutation({
        grant: input.grant,
        action: input.action,
        toolName: "thread_send",
        operation: `send-${input.disposition}`,
        semanticSlot: `send:${input.threadId}`,
        targetThreadId: input.threadId,
        providerCreationId: null,
        canonicalRequest: stableStringify([
          "thread_send",
          input.threadId,
          input.disposition,
          input.expectedTurnId,
          text,
        ]),
        preDispatch: Effect.gen(function* () {
          const liveTarget = yield* getManagedThread(input.grant, input.threadId);
          const liveCeiling = yield* getEffectiveRuntimeCeiling(authorization);
          const liveTurnId = liveTarget.thread.session?.activeTurnId ?? null;
          yield* validateSendTargetPrecondition({
            disposition: input.disposition,
            expectedTurnId: input.expectedTurnId,
            currentTurnId: liveTurnId,
            targetRuntimeMode: liveTarget.thread.runtimeMode,
            runtimeCeiling: liveCeiling,
          });
        }),
        effect: (provenance) =>
          Effect.gen(function* () {
            const result =
              input.disposition === "steer"
                ? yield* dispatch(
                    {
                      type: "thread.turn.steer",
                      commandId: commandId(input.action, "send-steer"),
                      threadId: input.threadId,
                      expectedTurnId: input.expectedTurnId,
                      message: {
                        messageId: messageId(input.action, "send-steer"),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      createdAt,
                    },
                    input.action,
                    authorization,
                    provenance,
                  )
                : yield* dispatch(
                    {
                      type: "thread.turn.start",
                      commandId: commandId(input.action, "send-start"),
                      threadId: input.threadId,
                      message: {
                        messageId: messageId(input.action, "send-start"),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      modelSelection: target.thread.modelSelection,
                      runtimeMode: target.thread.runtimeMode,
                      interactionMode: target.thread.interactionMode,
                      expectedTurnId: null,
                      providerRecoveryPolicy: "forbid",
                      createdAt,
                    },
                    input.action,
                    authorization,
                    provenance,
                  );
            return {
              actionId: input.action.actionId,
              operationId: operationId(input.action, `send-${input.disposition}`),
              targetThreadId: input.threadId,
              disposition: input.disposition,
              expectedTurnId: input.expectedTurnId,
              acceptedTurnId: input.disposition === "steer" ? input.expectedTurnId : null,
              acceptedProjectionSequence: result.sequence,
              providerConfirmation: "pending" as const,
            };
          }),
      });
    },
  );

  const interrupt: ThreadControlService["Service"]["interrupt"] = Effect.fn(
    "ThreadControlService.interrupt",
  )(function* (input) {
    const authorization = input.grant.authorization;
    yield* input.grant.verifier.authorize(authorization, "control");
    yield* input.grant.verifier.validateMutation(authorization, input.action);
    const target = yield* getManagedThread(input.grant, input.threadId);
    const currentTurnId = target.thread.session?.activeTurnId ?? null;
    yield* validateInterruptTargetPrecondition({
      expectedTurnId: input.expectedTurnId,
      currentTurnId,
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return yield* executeMutation({
      grant: input.grant,
      action: input.action,
      toolName: "thread_interrupt",
      operation: "interrupt",
      semanticSlot: `interrupt:${input.threadId}:${input.expectedTurnId}`,
      targetThreadId: input.threadId,
      providerCreationId: null,
      canonicalRequest: stableStringify(["thread_interrupt", input.threadId, input.expectedTurnId]),
      preDispatch: Effect.gen(function* () {
        const liveTarget = yield* getManagedThread(input.grant, input.threadId);
        const liveTurnId = liveTarget.thread.session?.activeTurnId ?? null;
        yield* validateInterruptTargetPrecondition({
          expectedTurnId: input.expectedTurnId,
          currentTurnId: liveTurnId,
        });
      }),
      effect: (provenance) =>
        Effect.gen(function* () {
          const result = yield* dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: commandId(input.action, "interrupt"),
              threadId: input.threadId,
              turnId: input.expectedTurnId,
              createdAt,
            },
            input.action,
            authorization,
            provenance,
          );
          return {
            actionId: input.action.actionId,
            operationId: operationId(input.action, "interrupt"),
            targetThreadId: input.threadId,
            disposition: "interrupt" as const,
            expectedTurnId: input.expectedTurnId,
            acceptedTurnId: input.expectedTurnId,
            acceptedProjectionSequence: result.sequence,
            providerConfirmation: "pending" as const,
          };
        }),
    });
  });

  return ThreadControlService.of({ list, get, create, send, interrupt });
});

export const ThreadControlServiceLive = Layer.effect(
  ThreadControlService,
  makeThreadControlService(),
);
