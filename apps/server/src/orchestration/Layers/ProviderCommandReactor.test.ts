// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@shuv2code/contracts";
import { createModelSelection } from "@shuv2code/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@shuv2code/contracts";
import { ProviderAdapterRequestError, ProviderValidationError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  providerEffectRecoveryLogFields,
  ProviderEffectTimeout,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });

    it("redacts sensitive provider recovery failures", () => {
      expect(
        providerEffectRecoveryLogFields({
          sensitiveProviderEffect: true,
          recoveryCause: "persistence stack",
          originalCause: "secret provider transcript",
          sanitizedCode: "provider_outcome_unknown",
        }),
      ).toEqual({
        cause: "provider_failure_recovery_failed",
        originalCause: "provider_outcome_unknown",
      });
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly providerEffectTimeout?: Duration.Input;
    readonly providerEffectRecoveryDispatchFailures?: number;
    readonly captureLogs?: boolean;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shuv2code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const steerTurn = vi.fn<ProviderServiceShape["steerTurn"]>((_) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      hasDurableSessionRecovery: () => Effect.succeed(false),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    let titleRegenerationCompletionDispatchAttempts = 0;
    let providerEffectRecoveryDispatchAttempts = 0;
    const logs: Array<{ readonly message: unknown }> = [];
    const logger = Logger.make(({ message }) => {
      logs.push({ message });
    });
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          dispatch: (command, options) => {
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            if (
              command.type === "thread.provider-effect.outcome.set" &&
              command.outcome.state !== "pending"
            ) {
              providerEffectRecoveryDispatchAttempts += 1;
              if (
                providerEffectRecoveryDispatchAttempts <=
                (input?.providerEffectRecoveryDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected provider effect recovery failure"));
              }
            }
            return engine.dispatch(command, options);
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(
        input?.captureLogs === true
          ? Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false }))
          : NodeServices.layer,
      ),
      Layer.provideMerge(
        input?.providerEffectTimeout === undefined
          ? Layer.empty
          : Layer.succeed(ProviderEffectTimeout, input.providerEffectTimeout),
      ),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readEvents: () =>
        runtime!.runPromise(
          Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((events) => Array.from(events))),
        ),
      logs,
      startSession,
      sendTurn,
      interruptTurn,
      steerTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      runEffect,
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
      get providerEffectRecoveryDispatchAttempts() {
        return providerEffectRecoveryDispatchAttempts;
      },
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("keeps the full retained context and excludes attachments outside it", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const retainedContext = "x".repeat(8_000);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toBeUndefined();
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "shuv2code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("reacts to thread.turn.steer-requested by steering the exact same turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-steer"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer"),
        threadId: ThreadId.make("thread-1"),
        expectedTurnId: asTurnId("turn-1"),
        message: {
          messageId: asMessageId("message-turn-steer"),
          role: "user",
          text: "Focus on the failing tests.",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: "Focus on the failing tests.",
      clientUserMessageId: "message-turn-steer",
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("starts an explicit idle-only turn when steering loses to terminal completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.steerTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/steer",
          detail: "Codex turn precondition failed: expected turn-terminal, found no active turn.",
        }),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-terminal-fallback"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-terminal"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-terminal-fallback"),
        threadId: ThreadId.make("thread-1"),
        expectedTurnId: asTurnId("turn-terminal"),
        message: {
          messageId: asMessageId("message-terminal-fallback"),
          role: "user",
          text: "Continue after completion.",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      input: "Continue after completion.",
      clientUserMessageId: "message-terminal-fallback",
      expectedTurnId: null,
      interactionMode: "default",
    });
    await waitFor(async () => {
      const outcomes = (await harness.readEvents()).filter(
        (event) => event.type === "thread.provider-effect-outcome-set",
      );
      return outcomes.length >= 4;
    });
    const outcomes = (await harness.readEvents()).flatMap((event) =>
      event.type === "thread.provider-effect-outcome-set" ? [event.payload.outcome] : [],
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "steer",
          state: "stale",
          sanitizedCode: "already_terminal",
        }),
        expect.objectContaining({ operation: "start", state: "pending" }),
        expect.objectContaining({
          operation: "start",
          state: "confirmed",
          sanitizedCode: "provider_acknowledged",
        }),
      ]),
    );
    const startOutcomes = outcomes.filter((outcome) => outcome.operation === "start");
    expect(startOutcomes[0]?.operationId).toBe(startOutcomes[1]?.operationId);
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
    ).toBe(false);
    expect(
      thread?.messages.find((message) => message.id === "message-terminal-fallback")?.turnId,
    ).toBeNull();
  });

  it("does not retry a stale steer target", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.steerTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.steerTurn",
          issue: "stale_target: expected turn 'turn-old', current turn is 'turn-new'.",
        }),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale-steer"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-old"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-stale-steer"),
        threadId: ThreadId.make("thread-1"),
        expectedTurnId: asTurnId("turn-old"),
        message: {
          messageId: asMessageId("message-stale-steer"),
          role: "user",
          text: "Do not retry this.",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(async () =>
      (await harness.readEvents()).some(
        (event) =>
          event.type === "thread.provider-effect-outcome-set" &&
          event.payload.outcome.sanitizedCode === "stale_target",
      ),
    );
    expect(harness.steerTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("records a derived start failure when the terminal fallback loses", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.steerTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.steerTurn",
          issue: "already_terminal: thread 'thread-1' has no active turn.",
        }),
      ),
    );
    harness.sendTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: "stale_target: thread 'thread-1' already has active turn 'turn-winner'.",
        }),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-fallback-loser"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-terminal"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-fallback-loser"),
        threadId: ThreadId.make("thread-1"),
        expectedTurnId: asTurnId("turn-terminal"),
        message: {
          messageId: asMessageId("message-fallback-loser"),
          role: "user",
          text: "Race another fallback.",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });
    expect(harness.steerTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const outcomes = (await harness.readEvents()).flatMap((event) =>
      event.type === "thread.provider-effect-outcome-set" ? [event.payload.outcome] : [],
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "steer",
          state: "stale",
          sanitizedCode: "already_terminal",
        }),
        expect.objectContaining({
          operation: "start",
          state: "stale",
          sanitizedCode: "stale_target",
        }),
      ]),
    );
  });

  it("sanitizes persisted voice-controller startup failures", async () => {
    const secret = "VOICE_TRANSCRIPT_AND_SDP_SECRET";
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.start",
            detail: `provider echoed transcript and SDP: ${secret}`,
            cause: new Error(`raw provider cause: ${secret}`),
          }),
        ),
    });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-voice-turn-start-provider-failure"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("voice-user-message-provider-failure"),
            role: "user",
            text: "sensitive spoken request",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        {
          actorProvenance: {
            actorKind: "voice-controller",
            voiceActionId: "voice-action-start",
          },
        },
      ),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status === "error"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const serialized = encodeUnknownJson(thread);
    expect(thread?.session?.lastError).toBe("provider_outcome_unknown");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: "provider_outcome_unknown",
      },
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw provider cause");
  });

  it("sanitizes persisted voice-controller steer and interrupt failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const secret = "VOICE_STEER_INTERRUPT_TRANSCRIPT_SDP_SECRET";
    harness.steerTurn.mockImplementation(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "thread/steer",
            detail: `steer echoed transcript and SDP: ${secret}`,
            cause: new Error(`steer raw cause: ${secret}`),
          }),
        ) as never,
    );
    harness.interruptTurn.mockImplementation(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "thread/interrupt",
            detail: `interrupt echoed transcript and SDP: ${secret}`,
            cause: new Error(`interrupt raw cause: ${secret}`),
          }),
        ) as never,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-voice-failures"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-voice-failures"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch(
        {
          type: "thread.turn.steer",
          commandId: CommandId.make("cmd-voice-turn-steer-failure"),
          threadId: ThreadId.make("thread-1"),
          expectedTurnId: asTurnId("turn-voice-failures"),
          message: {
            messageId: asMessageId("message-voice-turn-steer-failure"),
            role: "user",
            text: "sensitive steer request",
            attachments: [],
          },
          createdAt: now,
        },
        {
          actorProvenance: {
            actorKind: "voice-controller",
            voiceActionId: "voice-action-steer",
          },
        },
      ),
    );
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.steer.failed") ?? false
      );
    });

    await harness.runEffect(
      harness.engine.dispatch(
        {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-voice-turn-interrupt-failure"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-voice-failures"),
          createdAt: now,
        },
        {
          actorProvenance: {
            actorKind: "voice-controller",
            voiceActionId: "voice-action-interrupt",
          },
        },
      ),
    );
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ??
        false
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const failureActivities = thread?.activities.filter(
      (activity) =>
        activity.kind === "provider.turn.steer.failed" ||
        activity.kind === "provider.turn.interrupt.failed",
    );
    expect(failureActivities).toHaveLength(2);
    expect(failureActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payload: { detail: "provider_outcome_unknown" } }),
        expect.objectContaining({ payload: { detail: "provider_outcome_unknown" } }),
      ]),
    );
    const serialized = encodeUnknownJson(thread);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw cause");
  });

  it.each(["steer", "interrupt"] as const)(
    "times out a never-resolving provider %s with a terminal outcome",
    async (operation) => {
      const harness = await createHarness({ providerEffectTimeout: "250 millis" });
      const now = "2026-01-01T00:00:00.000Z";
      let providerEffectInterrupted = false;
      const neverResolvingEffect = Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            providerEffectInterrupted = true;
          }),
        ),
      );
      if (operation === "steer") {
        harness.steerTurn.mockImplementation(() => neverResolvingEffect as never);
      } else {
        harness.interruptTurn.mockImplementation(() => neverResolvingEffect as never);
      }

      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-set-timeout-${operation}`),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await harness.runEffect(
        operation === "steer"
          ? harness.engine.dispatch({
              type: "thread.turn.steer",
              commandId: CommandId.make("cmd-timeout-steer"),
              threadId: ThreadId.make("thread-1"),
              expectedTurnId: asTurnId("turn-1"),
              message: {
                messageId: asMessageId("message-timeout-steer"),
                role: "user",
                text: "Steer forever.",
                attachments: [],
              },
              createdAt: now,
            })
          : harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-timeout-interrupt"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-1"),
              createdAt: now,
            }),
      );

      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`cmd-after-timeout-${operation}`),
          threadId: ThreadId.make("thread-1"),
          title: `Processed after ${operation}`,
        }),
      );
      await waitFor(async () => {
        const model = await harness.readModel();
        return (
          model.threads.find((thread) => thread.id === ThreadId.make("thread-1"))?.title ===
          `Processed after ${operation}`
        );
      });
      await waitFor(() =>
        operation === "steer"
          ? harness.steerTurn.mock.calls.length === 1
          : harness.interruptTurn.mock.calls.length === 1,
      );
      await waitFor(() => providerEffectInterrupted);
      await waitFor(async () => {
        const outcomes = (await harness.readEvents()).flatMap((event) =>
          event.type === "thread.provider-effect-outcome-set" &&
          event.payload.outcome.operation === operation
            ? [event.payload.outcome]
            : [],
        );
        return outcomes.some((outcome) => outcome.state !== "pending");
      });

      const outcomes = (await harness.readEvents()).flatMap((event) =>
        event.type === "thread.provider-effect-outcome-set" &&
        event.payload.outcome.operation === operation
          ? [event.payload.outcome]
          : [],
      );
      const pending = outcomes.find((outcome) => outcome.state === "pending");
      const terminal = outcomes.find((outcome) => outcome.sanitizedCode === "provider_timeout");
      expect(terminal).toMatchObject({
        operation,
        state: "indeterminate",
        sanitizedCode: "provider_timeout",
      });
      expect(terminal?.operationId).toBe(pending?.operationId);
      await waitFor(async () => {
        const thread = (await harness.readModel()).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        return (
          thread?.activities.some(
            (activity) => activity.kind === `provider.turn.${operation}.failed`,
          ) ?? false
        );
      });
    },
  );

  it("times out a never-resolving provider turn start", async () => {
    const harness = await createHarness({ providerEffectTimeout: "250 millis" });
    const now = "2026-01-01T00:00:00.000Z";
    let providerEffectInterrupted = false;
    harness.sendTurn.mockImplementation(
      () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              providerEffectInterrupted = true;
            }),
          ),
        ) as never,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-timeout-start"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-timeout-start"),
          role: "user",
          text: "Start forever.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-after-timeout-start"),
        threadId: ThreadId.make("thread-1"),
        title: "Processed after start",
      }),
    );
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads.find((thread) => thread.id === ThreadId.make("thread-1"))?.title ===
        "Processed after start"
      );
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(() => providerEffectInterrupted);
    await waitFor(async () =>
      (await harness.readEvents()).some(
        (event) =>
          event.type === "thread.provider-effect-outcome-set" &&
          event.payload.outcome.operation === "start" &&
          event.payload.outcome.state === "indeterminate" &&
          event.payload.outcome.sanitizedCode === "provider_timeout",
      ),
    );
  });

  it.each(["steer", "interrupt"] as const)(
    "logs provider %s recovery failures from the detached fiber",
    async (operation) => {
      const harness = await createHarness({
        providerEffectRecoveryDispatchFailures: 1,
        captureLogs: true,
      });
      const now = "2026-01-01T00:00:00.000Z";
      const providerFailure = new ProviderAdapterRequestError({
        provider: ProviderDriverKind.make("codex"),
        method: operation === "steer" ? "thread/steer" : "thread/interrupt",
        detail: `${operation} failed`,
        cause: new Error(`${operation} failed`),
      });
      if (operation === "steer") {
        harness.steerTurn.mockImplementation(() => Effect.fail(providerFailure) as never);
      } else {
        harness.interruptTurn.mockImplementation(() => Effect.fail(providerFailure) as never);
      }

      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-set-recovery-${operation}`),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await harness.runEffect(
        operation === "steer"
          ? harness.engine.dispatch({
              type: "thread.turn.steer",
              commandId: CommandId.make("cmd-recovery-steer"),
              threadId: ThreadId.make("thread-1"),
              expectedTurnId: asTurnId("turn-1"),
              message: {
                messageId: asMessageId("message-recovery-steer"),
                role: "user",
                text: "Recover this steer.",
                attachments: [],
              },
              createdAt: now,
            })
          : harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-recovery-interrupt"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-1"),
              createdAt: now,
            }),
      );

      const message = `provider command reactor failed to recover turn ${operation} failure`;
      await waitFor(() =>
        operation === "steer"
          ? harness.steerTurn.mock.calls.length === 1
          : harness.interruptTurn.mock.calls.length === 1,
      );
      await waitFor(() => harness.providerEffectRecoveryDispatchAttempts === 1);
      await waitFor(() =>
        harness.logs.some((log) => Array.isArray(log.message) && log.message[0] === message),
      );
      const recoveryLog = harness.logs.find(
        (log) => Array.isArray(log.message) && log.message[0] === message,
      );
      const recoveryDetail = Array.isArray(recoveryLog?.message)
        ? recoveryLog.message[1]
        : undefined;
      expect(recoveryDetail).toMatchObject({
        eventType: `thread.turn-${operation}-requested`,
        threadId: ThreadId.make("thread-1"),
        originalCause: `${operation} failed`,
      });
      expect(String((recoveryDetail as { readonly cause?: unknown } | undefined)?.cause)).toContain(
        "Injected provider effect recovery failure",
      );

      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`cmd-after-recovery-${operation}`),
          threadId: ThreadId.make("thread-1"),
          title: `Processed after recovery ${operation}`,
        }),
      );
      await waitFor(async () => {
        const model = await harness.readModel();
        return (
          model.threads.find((thread) => thread.id === ThreadId.make("thread-1"))?.title ===
          `Processed after recovery ${operation}`
        );
      });
    },
  );

  it("keeps processing commands when a provider interrupt never resolves", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.interruptTurn.mockImplementation(() => Effect.never as never);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-hung-interrupt"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-hung-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-steer-after-hung-interrupt"),
        threadId: ThreadId.make("thread-1"),
        expectedTurnId: asTurnId("turn-1"),
        message: {
          messageId: asMessageId("message-steer-after-hung-interrupt"),
          role: "user",
          text: "Keep working despite the stuck interrupt.",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    await harness.drain();
  });
});
