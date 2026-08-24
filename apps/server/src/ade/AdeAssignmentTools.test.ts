import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import { BotId, KernelSessionId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeAssignmentEngine,
  AdeAssignmentKernelPort,
  type AdeAssignmentDeliveryBatch,
} from "./AdeAssignmentEngine.ts";
import { AdeAssignmentInlineChecks, AdeAssignmentToolHandlers } from "./AdeAssignmentTools.ts";
import {
  AdeScreenboxToolPlane,
  AdeToolGate,
  AdeToolHandlers,
  type AdeToolCallContext,
  type AdeToolOutcome,
} from "./AdeToolGate.ts";

const AT = "2026-08-24T00:00:00.000Z";

const seedProject = (sql: SqlClient.SqlClient, projectId: string, secondMateBotId: string) =>
  sql`
    INSERT INTO ade_projects (
      project_id, name, second_mate_bot_id, repo_path, repo_remote,
      integration_policy_default, check_commands_json,
      shared_specialist_allow_list_json, limits_overrides_json, created_at, updated_at
    ) VALUES (
      ${projectId}, ${projectId}, ${secondMateBotId}, NULL, NULL,
      'agent-review', '[]', '[]', NULL, ${AT}, ${AT}
    )
  `;

const seedBot = (
  sql: SqlClient.SqlClient,
  input: {
    botId: string;
    role?: "firstmate" | "second-mate" | "crew" | "workspace-specialist";
    projectId?: string | null;
  },
) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (
      ${input.botId}, ${input.botId}, NULL, ${input.role ?? "crew"}, 'Coder',
      ${input.projectId ?? null}, NULL, 0, ${AT}, NULL
    )
  `;

const seedBinding = (sql: SqlClient.SqlClient, botId: string) =>
  sql`
    INSERT INTO ade_bot_execution_bindings (
      binding_id, bot_id, engine, kernel_session_id, purpose, status,
      rollover_summary, created_at, updated_at
    ) VALUES (
      ${`binding-${botId}`}, ${botId}, 'shuvcode', ${`session-${botId}`},
      'primary-text', 'active', NULL, ${AT}, ${AT}
    )
  `;

const ctxFor = (botId: string, tool: string): AdeToolCallContext => ({
  botId: BotId.make(botId),
  purpose: "primary-text",
  engine: "shuvcode",
  sessionId: KernelSessionId.make(`session-${botId}`),
  tool,
});

const completedContent = (outcome: AdeToolOutcome): string => {
  assert.equal(outcome._tag, "completed");
  return outcome._tag === "completed" ? outcome.content : "";
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;

  const sends = yield* Ref.make<Array<AdeAssignmentDeliveryBatch>>([]);
  const steers = yield* Ref.make<Array<{ botId: string; text: string }>>([]);
  const portLayer = Layer.succeed(AdeAssignmentKernelPort, {
    kernelHealth: () => Effect.succeed({ available: true } as const),
    deliverResults: (batch: AdeAssignmentDeliveryBatch) =>
      Ref.update(sends, (all) => [...all, batch]),
    steerPrimary: (input: { botId: BotId; text: string }) =>
      Ref.update(steers, (all) => [...all, { botId: input.botId, text: input.text }]),
    isSessionLive: () => Effect.succeed(true),
  });

  const engineLayer = AdeAssignmentEngine.layer.pipe(Layer.provide(portLayer));
  const gateLayer = AdeToolGate.layer.pipe(
    Layer.provide(
      AdeAssignmentToolHandlers.layer.pipe(Layer.provideMerge(AdeToolHandlers.layerUnavailable)),
    ),
    Layer.provide(AdeAssignmentInlineChecks.layer),
    Layer.provide(AdeScreenboxToolPlane.layerNotEligible),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(portLayer),
  );
  const context = yield* Layer.build(gateLayer);
  const gate = yield* Effect.service(AdeToolGate).pipe(Effect.provide(context));
  const engine = yield* Effect.service(AdeAssignmentEngine).pipe(Effect.provide(context));
  return { sql, gate, engine, sends, steers };
});

const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

describe("ADE assignment tools through the gate", () => {
  describe("create_assignment", () => {
    scenario("dispatches end-to-end and is durably idempotent without a supplied key", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "coder" });

        const input = { recipientBotId: "coder", instruction: "ship the thing" };
        const first = yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), input);
        const replay = yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), input);

        const firstJson = JSON.parse(completedContent(first)) as {
          assignmentId: string;
          created: boolean;
        };
        const replayJson = JSON.parse(completedContent(replay)) as {
          assignmentId: string;
          created: boolean;
        };
        assert.isTrue(firstJson.created);
        assert.isFalse(replayJson.created);
        assert.equal(replayJson.assignmentId, firstJson.assignmentId);

        const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ade_assignments`;
        assert.equal(rows[0]?.count, 1);
      }),
    );

    scenario("refuses routing at another project's crew, and at the caller itself", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedProject(sql, "project-a", "mate-a");
        yield* seedProject(sql, "project-b", "mate-b");
        yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
        yield* seedBot(sql, { botId: "coder-a", projectId: "project-a" });
        yield* seedBot(sql, { botId: "mate-b", role: "second-mate", projectId: "project-b" });
        yield* seedBot(sql, { botId: "coder-b", projectId: "project-b" });

        const ownProject = yield* gate.dispatch(ctxFor("mate-a", "create_assignment"), {
          recipientBotId: "coder-a",
          instruction: "in-project work",
        });
        assert.equal(ownProject._tag, "completed");

        const crossProject = yield* gate.dispatch(ctxFor("mate-a", "create_assignment"), {
          recipientBotId: "coder-b",
          instruction: "someone else's crew",
        });
        assert.equal(crossProject._tag, "denied");
        assert.equal(
          crossProject._tag === "denied" ? crossProject.denial._tag : "",
          "routing-target-not-allowed",
        );

        const self = yield* gate.dispatch(ctxFor("mate-a", "create_assignment"), {
          recipientBotId: "mate-a",
          instruction: "self delegation",
        });
        assert.equal(self._tag, "denied");
      }),
    );

    scenario("shared workspace specialists follow the project's allow list", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedProject(sql, "project-a", "mate-a");
        yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
        yield* seedBot(sql, {
          botId: "specialist",
          role: "workspace-specialist",
          projectId: null,
        });

        const refused = yield* gate.dispatch(ctxFor("mate-a", "create_assignment"), {
          recipientBotId: "specialist",
          instruction: "please help",
        });
        assert.equal(refused._tag, "denied");

        yield* sql`
          UPDATE ade_projects SET shared_specialist_allow_list_json = '"all"'
          WHERE project_id = 'project-a'
        `;
        const allowed = yield* gate.dispatch(ctxFor("mate-a", "create_assignment"), {
          recipientBotId: "specialist",
          instruction: "please help",
        });
        assert.equal(allowed._tag, "completed");

        // Specialists themselves route nowhere.
        const specialistRouting = yield* gate.dispatch(ctxFor("specialist", "create_assignment"), {
          recipientBotId: "mate-a",
          instruction: "delegate back",
        });
        assert.equal(specialistRouting._tag, "denied");
      }),
    );
  });

  describe("report_assignment_result", () => {
    scenario("the owner reports, the result is captured and delivered exactly once", () =>
      Effect.gen(function* () {
        const { sql, gate, sends } = yield* setup;
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "coder" });
        yield* seedBinding(sql, "firstmate");

        const created = JSON.parse(
          completedContent(
            yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), {
              recipientBotId: "coder",
              instruction: "ship the thing",
            }),
          ),
        ) as { assignmentId: string };

        const reported = yield* gate.dispatch(ctxFor("coder", "report_assignment_result"), {
          assignmentId: created.assignmentId,
          status: "completed",
          summary: "shipped it",
          artifacts: [{ _tag: "file", path: "src/thing.ts" }],
        });
        assert.equal(reported._tag, "completed");

        const batches = yield* Ref.get(sends);
        assert.lengthOf(batches, 1);
        assert.equal(batches[0]!.targetBotId, "firstmate");
        assert.include(batches[0]!.text, "shipped it");
        assert.include(batches[0]!.text, "src/thing.ts");

        // A replayed tool call (the gate's dedupe is in-memory only) answers
        // idempotently — recorded: false — instead of being denied, and
        // neither rewrites the result nor delivers a second time.
        const replay = yield* gate.dispatch(ctxFor("coder", "report_assignment_result"), {
          assignmentId: created.assignmentId,
          status: "failed",
          summary: "overwrite attempt",
        });
        const replayJson = JSON.parse(completedContent(replay)) as {
          recorded: boolean;
          status: string;
        };
        assert.isFalse(replayJson.recorded);
        assert.equal(replayJson.status, "completed");
        assert.lengthOf(yield* Ref.get(sends), 1);

        const rows = yield* sql<{ status: string; result_json: string; delivered: number }>`
          SELECT status, result_json, delivered FROM ade_assignments
        `;
        assert.equal(rows[0]?.status, "completed");
        assert.equal(rows[0]?.delivered, 1);
        assert.include(rows[0]?.result_json ?? "", "shipped it");
      }),
    );

    scenario("another bot cannot report someone else's assignment", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "coder" });
        yield* seedBot(sql, { botId: "intruder" });

        const created = JSON.parse(
          completedContent(
            yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), {
              recipientBotId: "coder",
              instruction: "ship the thing",
            }),
          ),
        ) as { assignmentId: string };

        const denied = yield* gate.dispatch(ctxFor("intruder", "report_assignment_result"), {
          assignmentId: created.assignmentId,
          status: "completed",
          summary: "not mine",
        });
        assert.equal(denied._tag, "denied");
        assert.equal(denied._tag === "denied" ? denied.denial._tag : "", "assignment-not-owned");
      }),
    );
  });

  describe("fleet_read and steer_primary", () => {
    scenario("fleet_read reports bots and their open assignments", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "coder" });
        yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), {
          recipientBotId: "coder",
          instruction: "ship the thing",
        });

        const snapshot = JSON.parse(
          completedContent(yield* gate.dispatch(ctxFor("firstmate", "fleet_read"), {})),
        ) as {
          bots: ReadonlyArray<{ botId: string; assignments: ReadonlyArray<{ status: string }> }>;
        };
        assert.lengthOf(snapshot.bots, 2);
        const coder = snapshot.bots.find((bot) => bot.botId === "coder");
        assert.equal(coder?.assignments[0]?.status, "queued");
      }),
    );

    scenario("fleet_read is scoped by the routing grants, not the whole roster", () =>
      Effect.gen(function* () {
        const { sql, gate } = yield* setup;
        yield* seedProject(sql, "project-a", "mate-a");
        yield* seedProject(sql, "project-b", "mate-b");
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
        yield* seedBot(sql, { botId: "coder-a", projectId: "project-a" });
        yield* seedBot(sql, { botId: "mate-b", role: "second-mate", projectId: "project-b" });
        yield* seedBot(sql, { botId: "coder-b", projectId: "project-b" });

        const readAs = (botId: string) =>
          Effect.map(gate.dispatch(ctxFor(botId, "fleet_read"), {}), (outcome) =>
            (
              JSON.parse(completedContent(outcome)) as {
                bots: ReadonlyArray<{ botId: string }>;
              }
            ).bots
              .map((bot) => bot.botId)
              .sort(),
          );

        // Fleet-wide authority sees everyone; a project crew sees its own
        // project (including itself) and nothing across the boundary.
        assert.deepEqual(yield* readAs("firstmate"), [
          "coder-a",
          "coder-b",
          "firstmate",
          "mate-a",
          "mate-b",
        ]);
        assert.deepEqual(yield* readAs("coder-a"), ["coder-a", "mate-a"]);
        assert.deepEqual(yield* readAs("mate-b"), ["coder-b", "mate-b"]);
      }),
    );

    scenario("steer_primary reaches the live session and never cancels anything", () =>
      Effect.gen(function* () {
        const { sql, gate, engine, steers } = yield* setup;
        yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
        yield* seedBot(sql, { botId: "coder" });
        const created = JSON.parse(
          completedContent(
            yield* gate.dispatch(ctxFor("firstmate", "create_assignment"), {
              recipientBotId: "coder",
              instruction: "ship the thing",
            }),
          ),
        ) as { assignmentId: string };

        const withoutSession = yield* gate.dispatch(ctxFor("firstmate", "steer_primary"), {
          targetBotId: "coder",
          text: "prefer the smaller change",
        });
        assert.equal(withoutSession._tag, "failed");

        yield* seedBinding(sql, "coder");
        yield* engine.startAssignment(created.assignmentId as never);
        const steered = yield* gate.dispatch(ctxFor("firstmate", "steer_primary"), {
          targetBotId: "coder",
          text: "prefer the smaller change",
        });
        assert.equal(steered._tag, "completed");
        assert.deepEqual(yield* Ref.get(steers), [
          { botId: "coder", text: "prefer the smaller change" },
        ]);

        // Steering is not cancelling: the assignment keeps running.
        const assignment = yield* engine.getAssignment(created.assignmentId as never);
        assert.equal(assignment?.status, "running");
      }),
    );
  });
});
