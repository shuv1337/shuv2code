import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import {
  AutomationError,
  AutomationRunId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type AutomationCreateInput,
  type AutomationDeleteInput,
  type AutomationDeleteResult,
  type AutomationGetInput,
  type AutomationListInput,
  type AutomationListResult,
  type AutomationListRunsInput,
  type AutomationListRunsResult,
  type AutomationRun,
  type AutomationRunNowInput,
  type AutomationUpdateInput,
  type AutomationValidateScheduleInput,
  type AutomationValidationResult,
  type ProjectAutomation,
} from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationStore, type DueAutomation } from "./AutomationStore.ts";
import { validateAutomationSchedule } from "./AutomationSchedule.ts";

function dispatchError(cause: unknown): AutomationError {
  return new AutomationError({
    reason: "dispatch_failed",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const TURN_START_GRACE_MS = 60_000;

export class AutomationService extends Context.Service<
  AutomationService,
  {
    readonly list: (
      input: AutomationListInput,
    ) => Effect.Effect<AutomationListResult, AutomationError>;
    readonly get: (input: AutomationGetInput) => Effect.Effect<ProjectAutomation, AutomationError>;
    readonly create: (
      input: AutomationCreateInput,
    ) => Effect.Effect<ProjectAutomation, AutomationError>;
    readonly update: (
      input: AutomationUpdateInput,
    ) => Effect.Effect<ProjectAutomation, AutomationError>;
    readonly delete: (
      input: AutomationDeleteInput,
    ) => Effect.Effect<AutomationDeleteResult, AutomationError>;
    readonly runNow: (
      input: AutomationRunNowInput,
    ) => Effect.Effect<AutomationRun, AutomationError>;
    readonly listRuns: (
      input: AutomationListRunsInput,
    ) => Effect.Effect<AutomationListRunsResult, AutomationError>;
    readonly validateSchedule: (
      input: AutomationValidateScheduleInput,
    ) => Effect.Effect<AutomationValidationResult>;
    readonly sweepDue: () => Effect.Effect<void, AutomationError>;
    readonly reconcileRuns: () => Effect.Effect<void, AutomationError>;
  }
>()("shuv2code/automations/AutomationService") {}

export const make = Effect.gen(function* () {
  const store = yield* AutomationStore;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const requireAutomation = Effect.fn("AutomationService.requireAutomation")(function* (
    automationId: AutomationGetInput["automationId"],
    projectId?: AutomationGetInput["projectId"],
  ) {
    const automation = yield* store.get(automationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AutomationError({ reason: "not_found", message: "Automation not found." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (projectId !== undefined && automation.projectId !== projectId) {
      return yield* new AutomationError({ reason: "not_found", message: "Automation not found." });
    }
    return automation;
  });

  const requireProject = Effect.fn("AutomationService.requireProject")(function* (
    projectId: AutomationCreateInput["projectId"],
  ) {
    return yield* snapshots.getProjectShellById(projectId).pipe(
      Effect.mapError(
        (cause) => new AutomationError({ reason: "persistence_failed", message: cause.message }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new AutomationError({ reason: "project_not_found", message: "Project not found." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  const completeRun = (
    runId: AutomationRunId,
    status: "completed" | "failed",
    completedAt: string,
    error: string | null,
  ) => store.updateRun({ runId, status, completedAt, error }).pipe(Effect.asVoid);

  const dispatchAutomation = Effect.fn("AutomationService.dispatchAutomation")(function* (
    automation: ProjectAutomation,
    queued: AutomationRun,
  ) {
    return yield* Effect.gen(function* () {
      const project = yield* requireProject(automation.projectId);
      const createdAt = queued.startedAt ?? DateTime.formatIso(yield* DateTime.now);
      const threadId = queued.threadId ?? ThreadId.make(queued.id);
      const messageId = MessageId.make(`automation:${queued.id}:prompt`);
      const commandId = (tag: string) => CommandId.make(`automation:${queued.id}:${tag}`);

      const starting = yield* store.updateRun({
        runId: queued.id,
        status: "queued",
        threadId,
        startedAt: createdAt,
        completedAt: null,
        error: null,
      });

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: commandId("thread-create"),
          threadId,
          projectId: automation.projectId,
          title: `[Automation] ${automation.name}`,
          modelSelection: automation.modelSelection,
          runtimeMode: automation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: automation.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: project.workspaceRoot,
          createdAt,
        })
        .pipe(Effect.mapError(dispatchError));

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: commandId("turn-start"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: automation.prompt,
            attachments: [],
          },
          modelSelection: automation.modelSelection,
          titleSeed: automation.name,
          runtimeMode: automation.runtimeMode,
          interactionMode: automation.interactionMode,
          createdAt,
        })
        .pipe(
          Effect.mapError(dispatchError),
          Effect.tapError(() =>
            engine
              .dispatch({
                type: "thread.delete",
                commandId: commandId("thread-delete"),
                threadId,
              })
              .pipe(Effect.ignoreCause({ log: true })),
          ),
        );

      const running = yield* store.updateRun({
        runId: starting.id,
        status: "running",
      });
      yield* store.setLastRunAt(automation.id, createdAt);
      return running;
    }).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const completedAt = DateTime.formatIso(yield* DateTime.now);
          yield* store
            .updateRun({
              runId: queued.id,
              status: "failed",
              completedAt,
              error: error.message,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }),
      ),
    );
  });

  const reconcileRun = Effect.fn("AutomationService.reconcileRun")(function* (run: AutomationRun) {
    if (run.status === "queued") {
      const automation = yield* requireAutomation(run.automationId, run.projectId);
      yield* dispatchAutomation(automation, run);
      return;
    }
    if (run.threadId === null) {
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* completeRun(run.id, "failed", completedAt, "Run stopped before a thread was created.");
      return;
    }

    const thread = yield* snapshots
      .getThreadShellById(run.threadId)
      .pipe(Effect.mapError((cause) => dispatchError(cause)));
    if (Option.isNone(thread)) {
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* completeRun(run.id, "failed", completedAt, "Automation thread no longer exists.");
      return;
    }
    const turn = thread.value.latestTurn;
    if (turn === null) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const startedAt =
        run.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(run.startedAt);
      if (Date.parse(now) - startedAt < TURN_START_GRACE_MS) return;
      yield* completeRun(
        run.id,
        "failed",
        now,
        "Automation thread was created, but its turn did not start.",
      );
      return;
    }
    if (turn.state === "running") return;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* completeRun(
      run.id,
      turn.state === "completed" ? "completed" : "failed",
      turn.completedAt ?? now,
      turn.state === "completed"
        ? null
        : (thread.value.session?.lastError ?? `Automation thread ended with ${turn.state}.`),
    );
  });

  const executeAutomation = Effect.fn("AutomationService.executeAutomation")(function* (
    automation: ProjectAutomation,
    trigger: AutomationRun["trigger"],
    scheduledFor: string,
  ) {
    const run = yield* store.admitRun({ automation, trigger, scheduledFor });
    return run.status === "skipped" ? run : yield* dispatchAutomation(automation, run);
  });

  const list: AutomationService["Service"]["list"] = (input) =>
    store.list(input.projectId).pipe(Effect.map((automations) => ({ automations })));

  const get: AutomationService["Service"]["get"] = (input) =>
    requireAutomation(input.automationId, input.projectId);

  const create: AutomationService["Service"]["create"] = Effect.fn("AutomationService.create")(
    function* (input) {
      yield* requireProject(input.projectId);
      return yield* store.create(input);
    },
  );

  const update: AutomationService["Service"]["update"] = Effect.fn("AutomationService.update")(
    function* (input) {
      yield* requireAutomation(input.automationId, input.projectId);
      return yield* store.update(input);
    },
  );

  const deleteAutomation: AutomationService["Service"]["delete"] = Effect.fn(
    "AutomationService.delete",
  )(function* (input) {
    const automation = yield* requireAutomation(input.automationId, input.projectId);
    if (yield* store.hasActiveRun(automation.id)) {
      return yield* new AutomationError({
        reason: "conflict",
        message: "Wait for the active run to finish before deleting this automation.",
      });
    }
    const deleted = yield* store.delete(automation.id);
    return { deleted };
  });

  const runNow: AutomationService["Service"]["runNow"] = Effect.fn("AutomationService.runNow")(
    function* (input) {
      const automation = yield* requireAutomation(input.automationId, input.projectId);
      const scheduledFor = DateTime.formatIso(yield* DateTime.now);
      return yield* executeAutomation(automation, "manual", scheduledFor);
    },
  );

  const listRuns: AutomationService["Service"]["listRuns"] = (input) =>
    requireAutomation(input.automationId, input.projectId).pipe(
      Effect.andThen(store.listRuns(input.automationId, input.limit ?? 50)),
      Effect.map((runs) => ({ runs })),
    );

  const validateSchedule: AutomationService["Service"]["validateSchedule"] = (input) =>
    DateTime.now.pipe(Effect.map((now) => validateAutomationSchedule(input, now)));

  const sweepDue: AutomationService["Service"]["sweepDue"] = Effect.fn(
    "AutomationService.sweepDue",
  )(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const due = yield* store.claimDue(now);
    yield* Effect.forEach(
      due,
      ({ automation, scheduledFor, run }: DueAutomation) => {
        if (run.status === "skipped") return Effect.void;
        return dispatchAutomation(automation, run).pipe(
          Effect.catch((error: AutomationError) =>
            Effect.logError("scheduled automation failed to start", {
              automationId: automation.id,
              scheduledFor,
              detail: error.message,
            }),
          ),
          Effect.asVoid,
        );
      },
      { concurrency: 4, discard: true },
    );
  });

  const reconcileRuns: AutomationService["Service"]["reconcileRuns"] = Effect.fn(
    "AutomationService.reconcileRuns",
  )(function* () {
    const runs = yield* store.listActiveRuns();
    yield* Effect.forEach(runs, (run) => reconcileRun(run), { discard: true });
  });

  return AutomationService.of({
    list,
    get,
    create,
    update,
    delete: deleteAutomation,
    runNow,
    listRuns,
    validateSchedule,
    sweepDue,
    reconcileRuns,
  });
});

export const layer = Layer.effect(AutomationService, make);

export const schedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* AutomationService;
    const tick = service.reconcileRuns().pipe(
      Effect.andThen(service.sweepDue()),
      Effect.catch((error) =>
        Effect.logWarning("automation scheduler tick failed", { detail: error.message }),
      ),
    );
    yield* tick.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
  }),
);
