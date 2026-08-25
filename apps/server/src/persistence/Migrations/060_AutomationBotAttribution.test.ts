import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_AutomationBotAttribution", (it) => {
  it.effect("adds a nullable bot attribution that leaves existing rows alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 59 });
      // A routine that predates the column. It must survive the migration as a
      // project automation, not as an orphan or a backfill placeholder.
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'Demo', '/tmp/demo', '[]',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO project_automations (
          automation_id, project_id, name, prompt, enabled, cron_expression, time_zone,
          model_selection_json, runtime_mode, interaction_mode, concurrency_policy,
          created_at, updated_at
        ) VALUES (
          'automation-1', 'project-1', 'Nightly', 'Run it', 0, '0 9 * * *', 'UTC',
          '{}', 'full-access', 'default', 'skip',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 60 });

      const rows = yield* sql<{ ade_bot_id: string | null }>`
        SELECT ade_bot_id FROM project_automations WHERE automation_id = 'automation-1'
      `;
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]?.ade_bot_id, null);
    }),
  );

  it.effect("indexes the rail's query — bot first, then project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(project_automations)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_project_automations_bot"));

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_project_automations_bot')
      `;
      // Bot-first, because the rail always asks "this bot, in this project";
      // the existing project-first index already serves Settings' paging.
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["ade_bot_id", "project_id"],
      );
    }),
  );

  it.effect("does not cascade a routine away when its bot is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`PRAGMA foreign_keys = ON`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-2', 'Demo', '/tmp/demo-2', '[]',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO project_automations (
          automation_id, project_id, ade_bot_id, name, prompt, enabled, cron_expression,
          time_zone, model_selection_json, runtime_mode, interaction_mode, concurrency_policy,
          created_at, updated_at
        ) VALUES (
          'automation-2', 'project-2', 'bot-gone', 'Nightly', 'Run it', 1, '0 9 * * *', 'UTC',
          '{}', 'full-access', 'default', 'skip',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      // The attribution is deliberately not a foreign key: a routine's
      // schedule is a promise to the captain, not to the bot named on it, and
      // archiving a bot must not silently delete a working nightly job. An
      // attribution to a bot that no longer exists simply stops matching the
      // rail's filter.
      const rows = yield* sql<{ ade_bot_id: string | null }>`
        SELECT ade_bot_id FROM project_automations WHERE automation_id = 'automation-2'
      `;
      assert.strictEqual(rows[0]?.ade_bot_id, "bot-gone");
    }),
  );
});
