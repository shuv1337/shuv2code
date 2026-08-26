import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import { BotId, KernelSessionId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import {
  ADE_MAX_BOTS_PER_PROJECT,
  ADE_MAX_FLEET_BOTS,
  AdeFleetProvisioningInlineChecks,
  AdeFleetProvisioningToolHandlers,
} from "./AdeFleetProvisioningTools.ts";
import {
  AdeScreenboxToolPlane,
  AdeToolGate,
  AdeToolHandlers,
  AdeToolInlineChecks,
  type AdeToolCallContext,
  type AdeToolOutcome,
} from "./AdeToolGate.ts";

const AT = "2026-08-25T00:00:00.000Z";

const seedProject = (sql: SqlClient.SqlClient, projectId: string, secondMateBotId: string) =>
  sql`
    INSERT INTO ade_projects (
      project_id, name, second_mate_bot_id, repo_path, repo_remote,
      integration_policy_default, check_commands_json,
      shared_specialist_allow_list_json, limits_overrides_json, created_at, updated_at
    ) VALUES (
      ${projectId}, ${projectId}, ${secondMateBotId}, NULL, NULL,
      'agent-review', '[]', '"all"', NULL, ${AT}, ${AT}
    )
  `;

const seedBot = (
  sql: SqlClient.SqlClient,
  input: {
    botId: string;
    name?: string;
    role?: "firstmate" | "second-mate" | "crew" | "workspace-specialist";
    projectId?: string | null;
    archived?: boolean;
  },
) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (
      ${input.botId}, ${input.name ?? input.botId}, NULL, ${input.role ?? "crew"}, 'Coder',
      ${input.projectId ?? null}, NULL, 0, ${AT}, ${input.archived === true ? AT : null}
    )
  `;

const ctxFor = (botId: string): AdeToolCallContext => ({
  botId: BotId.make(botId),
  purpose: "primary-text",
  engine: "shuvcode",
  sessionId: KernelSessionId.make(`session-${botId}`),
  tool: "create_bot",
});

interface CreatedBotResult {
  readonly botId: string;
  readonly name: string;
  readonly roleTag: string;
  readonly projectId: string | null;
  readonly summary: string;
}

const created = (outcome: AdeToolOutcome): CreatedBotResult => {
  assert.equal(outcome._tag, "completed");
  return JSON.parse(outcome._tag === "completed" ? outcome.content : "{}") as CreatedBotResult;
};

const denialReason = (outcome: AdeToolOutcome): string => {
  assert.equal(outcome._tag, "denied");
  if (outcome._tag !== "denied") return "";
  assert.equal(outcome.denial._tag, "bot-provisioning-not-allowed");
  return outcome.denial._tag === "bot-provisioning-not-allowed" ? outcome.denial.reason : "";
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;

  const gateLayer = AdeToolGate.layer.pipe(
    Layer.provide(
      AdeFleetProvisioningToolHandlers.layer.pipe(
        Layer.provide(AdeToolHandlers.layerUnavailable),
        Layer.provide(AdeBootstrap.layer),
      ),
    ),
    Layer.provide(
      AdeFleetProvisioningInlineChecks.layer.pipe(
        Layer.provide(AdeToolInlineChecks.layerFailClosed),
      ),
    ),
    Layer.provide(AdeScreenboxToolPlane.layerNotEligible),
  );
  const context = yield* Layer.build(gateLayer);
  const gate = yield* Effect.service(AdeToolGate).pipe(Effect.provide(context));
  return { sql, gate };
});

const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

describe("create_bot through the gate", () => {
  scenario("lets the Firstmate provision crew into an existing project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "reviewer",
        projectId: "project-a",
      });
      const result = created(outcome);
      assert.equal(result.name, "Reviewer");
      assert.equal(result.roleTag, "Reviewer");
      assert.equal(result.projectId, "project-a");
      assert.include(result.summary, "Reviewer");
      assert.include(result.summary, "project-a");
      assert.include(result.summary, "create_assignment");

      // Went through AdeBootstrap: persona v1 and an empty memory doc exist.
      const rows = yield* sql<{ name: string; structural_role: string; project_id: string }>`
        SELECT name, structural_role, project_id FROM ade_bots WHERE bot_id = ${result.botId}
      `;
      assert.equal(rows[0]?.structural_role, "crew");
      assert.equal(rows[0]?.project_id, "project-a");
      const personas = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_persona_versions WHERE bot_id = ${result.botId}
      `;
      assert.equal(personas[0]?.n, 1);
      const memory = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_memory_documents WHERE bot_id = ${result.botId}
      `;
      assert.equal(memory[0]?.n, 1);
    }),
  );

  scenario("makes a fleet-shared specialist when the Firstmate names no project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const omitted = created(
        yield* gate.dispatch(ctxFor("firstmate"), { templateId: "researcher" }),
      );
      assert.equal(omitted.projectId, null);
      assert.include(omitted.summary, "fleet-shared");

      const explicitNull = created(
        yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder", projectId: null }),
      );
      assert.equal(explicitNull.projectId, null);
    }),
  );

  scenario("refuses a specialist and crew: only coordinators provision", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      yield* seedBot(sql, { botId: "coder-a", role: "crew", projectId: "project-a" });
      yield* seedBot(sql, { botId: "shared", role: "workspace-specialist", projectId: null });

      const byCrew = yield* gate.dispatch(ctxFor("coder-a"), { templateId: "coder" });
      assert.include(denialReason(byCrew), "only coordinators");

      const bySpecialist = yield* gate.dispatch(ctxFor("shared"), { templateId: "coder" });
      assert.include(denialReason(bySpecialist), "only coordinators");

      const bots = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ade_bots`;
      assert.equal(bots[0]?.n, 3);
    }),
  );

  scenario("scopes a Second Mate to its own project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedProject(sql, "project-b", "mate-b");
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      yield* seedBot(sql, { botId: "mate-b", role: "second-mate", projectId: "project-b" });

      const own = created(
        yield* gate.dispatch(ctxFor("mate-a"), { templateId: "coder", projectId: "project-a" }),
      );
      assert.equal(own.projectId, "project-a");

      // Omitted resolves to the caller's project rather than fleet-shared.
      const implied = created(yield* gate.dispatch(ctxFor("mate-a"), { templateId: "researcher" }));
      assert.equal(implied.projectId, "project-a");

      const other = yield* gate.dispatch(ctxFor("mate-a"), {
        templateId: "coder",
        projectId: "project-b",
      });
      assert.include(denialReason(other), "its own project");

      const shared = yield* gate.dispatch(ctxFor("mate-a"), {
        templateId: "coder",
        projectId: null,
      });
      assert.include(denialReason(shared), "Firstmate");
    }),
  );

  scenario("refuses an unknown project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "coder",
        projectId: "project-ghost",
      });
      assert.include(denialReason(outcome), "no project 'project-ghost' exists");
    }),
  );

  scenario("refuses reserved coordinator templates at the schema", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      for (const templateId of ["firstmate", "second-mate"]) {
        const outcome = yield* gate.dispatch(ctxFor("firstmate"), { templateId });
        assert.equal(outcome._tag, "denied");
        assert.equal(outcome._tag === "denied" ? outcome.denial._tag : "", "invalid-input");
      }
    }),
  );

  scenario("suffixes a colliding name, case-insensitively, across the fleet", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      // A live "reviewer" in *another* corner of the fleet still collides.
      yield* seedBot(sql, { botId: "existing", name: "reviewer", projectId: null });

      const second = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "reviewer",
          projectId: "project-a",
        }),
      );
      assert.equal(second.name, "Reviewer 2");

      const third = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "reviewer",
          projectId: "project-a",
        }),
      );
      assert.equal(third.name, "Reviewer 3");

      // An explicit name takes the same treatment.
      const named = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "coder",
          projectId: "project-a",
          name: "Reviewer",
        }),
      );
      assert.equal(named.name, "Reviewer 4");
    }),
  );

  scenario("refuses at the per-project cap, naming the cap and the count", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      for (let index = 1; index < ADE_MAX_BOTS_PER_PROJECT; index += 1) {
        yield* seedBot(sql, { botId: `crew-${index}`, projectId: "project-a" });
      }
      // Archived crew does not count against the cap.
      yield* seedBot(sql, { botId: "retired", projectId: "project-a", archived: true });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "coder",
        projectId: "project-a",
      });
      const reason = denialReason(outcome);
      assert.include(reason, `cap of ${ADE_MAX_BOTS_PER_PROJECT} bots`);
      assert.include(reason, `(${ADE_MAX_BOTS_PER_PROJECT} active)`);
    }),
  );

  scenario("refuses at the fleet cap even for a fleet-shared specialist", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      for (let index = 1; index < ADE_MAX_FLEET_BOTS; index += 1) {
        yield* seedBot(sql, { botId: `shared-${index}`, projectId: null });
      }

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" });
      const reason = denialReason(outcome);
      assert.include(reason, `cap of ${ADE_MAX_FLEET_BOTS} bots`);
      assert.include(reason, `(${ADE_MAX_FLEET_BOTS} active)`);
    }),
  );

  scenario("refuses a caller that no longer exists", () =>
    Effect.gen(function* () {
      const { gate } = yield* setup;
      const outcome = yield* gate.dispatch(ctxFor("ghost"), { templateId: "coder" });
      assert.include(denialReason(outcome), "no longer exists");
    }),
  );
});
