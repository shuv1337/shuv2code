import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@shuv2code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AutomationStore from "./AutomationStore.ts";
import { AutomationService } from "./AutomationService.ts";
import * as AutomationServiceLive from "./AutomationService.ts";

const projectId = ProjectId.make("automation-service-project");
const dispatchedCommands: Array<OrchestrationCommand> = [];
let failedCommandType: OrchestrationCommand["type"] | null = null;
const projectedThreads = new Map<string, OrchestrationThreadShell>();

function projectedThread(
  threadId: ThreadId,
  latestTurn: OrchestrationLatestTurn | null,
): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId,
    title: "Automation thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "anthropic/claude-sonnet-4-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/automation-service-project",
    latestTurn,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const serviceLayer = it.layer(
  AutomationServiceLive.layer.pipe(
    Layer.provideMerge(AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    Layer.provideMerge(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        dispatch: (command) =>
          failedCommandType === command.type
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Injected automation dispatch failure.",
                }),
              )
            : Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: (candidateProjectId) =>
          Effect.succeed(
            candidateProjectId === projectId
              ? Option.some({
                  id: projectId,
                  title: "Automation service project",
                  workspaceRoot: "/tmp/automation-service-project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-07-30T00:00:00.000Z",
                  updatedAt: "2026-07-30T00:00:00.000Z",
                })
              : Option.none(),
          ),
        getThreadShellById: (threadId) =>
          Effect.succeed(Option.fromNullishOr(projectedThreads.get(threadId))),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

serviceLayer("AutomationService", (it) => {
  it.effect("starts project threads and skips overlapping runs when configured", () =>
    Effect.gen(function* () {
      const service = yield* AutomationService;
      const sql = yield* SqlClient.SqlClient;
      dispatchedCommands.length = 0;
      failedCommandType = null;
      projectedThreads.clear();

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation service project', '/tmp/automation-service-project', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const automation = yield* service.create({
        projectId,
        name: "Daily scan",
        prompt: "Run the complete scan",
        enabled: true,
        cronExpression: "0 9 * * *",
        timeZone: "Europe/London",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "anthropic/claude-sonnet-4-5",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        concurrencyPolicy: "skip",
      });

      const runs = yield* Effect.all(
        [
          service.runNow({ projectId, automationId: automation.id }),
          service.runNow({ projectId, automationId: automation.id }),
        ],
        { concurrency: "unbounded" },
      );
      const first = runs.find((run) => run.status === "running");
      const second = runs.find((run) => run.status === "skipped");
      assert.ok(first !== undefined);
      assert.ok(first.threadId !== null);
      assert.ok(second !== undefined);
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.turn.start"],
      );
      const createCommand = dispatchedCommands[0];
      assert.strictEqual(createCommand?.type, "thread.create");
      if (createCommand?.type === "thread.create") {
        assert.strictEqual(createCommand.worktreePath, "/tmp/automation-service-project");
        assert.strictEqual(createCommand.title, "[Automation] Daily scan");
        assert.deepStrictEqual(createCommand.modelSelection, automation.modelSelection);
        assert.strictEqual(createCommand.runtimeMode, "full-access");
        assert.strictEqual(createCommand.interactionMode, "default");
        assert.strictEqual(createCommand.commandId, `automation:${first.id}:thread-create`);
        assert.strictEqual(String(createCommand.threadId), String(first.id));
      }
      const turnCommand = dispatchedCommands[1];
      assert.strictEqual(turnCommand?.type, "thread.turn.start");
      if (turnCommand?.type === "thread.turn.start") {
        assert.deepStrictEqual(turnCommand.modelSelection, automation.modelSelection);
        assert.strictEqual(turnCommand.message.text, "Run the complete scan");
        assert.strictEqual(turnCommand.runtimeMode, "full-access");
        assert.strictEqual(turnCommand.interactionMode, "default");
        assert.strictEqual(turnCommand.commandId, `automation:${first.id}:turn-start`);
        assert.strictEqual(turnCommand.message.messageId, `automation:${first.id}:prompt`);
      }
      assert.strictEqual(dispatchedCommands.length, 2);

      yield* sql`
        UPDATE project_automations
        SET next_run_at = '1969-12-31T23:59:59.000Z'
        WHERE automation_id = ${automation.id}
      `;
      yield* service.sweepDue();
      assert.strictEqual(dispatchedCommands.length, 2);

      const history = yield* service.listRuns({
        projectId,
        automationId: automation.id,
        limit: 50,
      });
      assert.deepStrictEqual(
        new Set(history.runs.map((run) => run.status)),
        new Set(["running", "skipped"]),
      );
      assert.ok(
        history.runs.some((run) => run.trigger === "scheduled" && run.status === "skipped"),
      );

      const parallelAutomation = yield* service.create({
        projectId,
        name: "Parallel custom provider",
        prompt: "Run both copies",
        enabled: false,
        cronExpression: "0 10 * * *",
        timeZone: "UTC",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        concurrencyPolicy: "parallel",
      });
      dispatchedCommands.length = 0;
      const parallelRuns = yield* Effect.all(
        [
          service.runNow({ projectId, automationId: parallelAutomation.id }),
          service.runNow({ projectId, automationId: parallelAutomation.id }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        parallelRuns.map((run) => run.status),
        ["running", "running"],
      );
      assert.notStrictEqual(parallelRuns[0]?.threadId, parallelRuns[1]?.threadId);
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.create").length,
        2,
      );
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.turn.start").length,
        2,
      );
      for (const command of dispatchedCommands) {
        if (command.type === "thread.create" || command.type === "thread.turn.start") {
          assert.deepStrictEqual(command.modelSelection, parallelAutomation.modelSelection);
          assert.strictEqual(command.runtimeMode, "approval-required");
          assert.strictEqual(command.interactionMode, "plan");
        }
      }

      const deletion = yield* Effect.flip(
        service.delete({ projectId, automationId: automation.id }),
      );
      assert.strictEqual(deletion.reason, "conflict");
    }),
  );

  it.effect("records dispatch failures and prevents cross-project access", () =>
    Effect.gen(function* () {
      const service = yield* AutomationService;
      const sql = yield* SqlClient.SqlClient;
      dispatchedCommands.length = 0;
      failedCommandType = null;
      projectedThreads.clear();

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation service project', '/tmp/automation-service-project', NULL,
          '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', NULL
        )
      `;

      const automation = yield* service.create({
        projectId,
        name: "Failure probe",
        prompt: "Exercise the provider",
        enabled: false,
        cronExpression: "0 9 * * *",
        timeZone: "UTC",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "auto",
        interactionMode: "default",
        concurrencyPolicy: "skip",
      });

      const otherProjectId = ProjectId.make("another-project");
      const crossProjectError = yield* Effect.flip(
        service.runNow({ projectId: otherProjectId, automationId: automation.id }),
      );
      assert.strictEqual(crossProjectError.reason, "not_found");
      assert.strictEqual(dispatchedCommands.length, 0);
      assert.strictEqual(
        (yield* service.list({ projectId: otherProjectId })).automations.length,
        0,
      );

      failedCommandType = "thread.create";
      const createError = yield* Effect.flip(
        service.runNow({ projectId, automationId: automation.id }),
      );
      assert.strictEqual(createError.reason, "dispatch_failed");
      let history = yield* service.listRuns({ projectId, automationId: automation.id, limit: 50 });
      assert.strictEqual(history.runs.length, 1);
      assert.strictEqual(history.runs[0]?.status, "failed");
      assert.strictEqual(String(history.runs[0]?.threadId), String(history.runs[0]?.id));

      failedCommandType = "thread.turn.start";
      const turnError = yield* Effect.flip(
        service.runNow({ projectId, automationId: automation.id }),
      );
      assert.strictEqual(turnError.reason, "dispatch_failed");
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
      history = yield* service.listRuns({ projectId, automationId: automation.id, limit: 50 });
      assert.strictEqual(history.runs.length, 2);
      assert.ok(history.runs.every((run) => run.status === "failed"));
      assert.ok(history.runs.some((run) => run.threadId !== null));

      failedCommandType = null;
    }),
  );

  it.effect("reconciles interrupted, completed, active, and stalled runs", () =>
    Effect.gen(function* () {
      const service = yield* AutomationService;
      const store = yield* AutomationStore.AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      dispatchedCommands.length = 0;
      failedCommandType = null;
      projectedThreads.clear();

      yield* sql`DELETE FROM automation_runs`;
      yield* sql`DELETE FROM project_automations`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Automation service project', '/tmp/automation-service-project', NULL,
          '[]', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', NULL
        )
      `;

      const automation = yield* service.create({
        projectId,
        name: "Recovery probe",
        prompt: "Recover unfinished work",
        enabled: false,
        cronExpression: "0 9 * * *",
        timeZone: "UTC",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "anthropic/claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        concurrencyPolicy: "parallel",
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const admit = (suffix: string) =>
        store.admitRun({
          automation,
          trigger: "manual",
          scheduledFor: `1970-01-01T00:00:0${suffix}.000Z`,
        });

      const noThread = yield* admit("1");
      const missingThreadId = ThreadId.make("missing-thread");
      const missingThread = yield* store.updateRun({
        runId: (yield* admit("2")).id,
        status: "running",
        threadId: missingThreadId,
        startedAt: now,
      });
      const completedThreadId = ThreadId.make("completed-thread");
      const completed = yield* store.updateRun({
        runId: (yield* admit("3")).id,
        status: "running",
        threadId: completedThreadId,
        startedAt: now,
      });
      const activeThreadId = ThreadId.make("active-thread");
      const active = yield* store.updateRun({
        runId: (yield* admit("4")).id,
        status: "running",
        threadId: activeThreadId,
        startedAt: now,
      });
      const noTurnThreadId = ThreadId.make("no-turn-thread");
      const noTurn = yield* store.updateRun({
        runId: (yield* admit("5")).id,
        status: "queued",
        threadId: noTurnThreadId,
        startedAt: now,
      });

      projectedThreads.set(
        completedThreadId,
        projectedThread(completedThreadId, {
          turnId: TurnId.make("completed-turn"),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: MessageId.make("completed-message"),
        }),
      );
      projectedThreads.set(
        activeThreadId,
        projectedThread(activeThreadId, {
          turnId: TurnId.make("active-turn"),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        }),
      );
      projectedThreads.set(noTurnThreadId, projectedThread(noTurnThreadId, null));

      yield* service.reconcileRuns();
      let runs = yield* store.listRuns(automation.id, 50);
      const status = (runId: typeof noThread.id) => runs.find((run) => run.id === runId)?.status;
      assert.strictEqual(status(noThread.id), "running");
      assert.strictEqual(status(missingThread.id), "failed");
      assert.strictEqual(status(completed.id), "completed");
      assert.strictEqual(status(active.id), "running");
      assert.strictEqual(status(noTurn.id), "running");
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.commandId),
        [
          `automation:${noThread.id}:thread-create`,
          `automation:${noThread.id}:turn-start`,
          `automation:${noTurn.id}:thread-create`,
          `automation:${noTurn.id}:turn-start`,
        ],
      );

      yield* TestClock.adjust("61 seconds");
      yield* service.reconcileRuns();
      runs = yield* store.listRuns(automation.id, 50);
      assert.strictEqual(status(active.id), "running");
      assert.strictEqual(status(noThread.id), "failed");
      assert.strictEqual(status(noTurn.id), "failed");
    }),
  );
});
