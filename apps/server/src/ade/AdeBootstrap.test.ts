import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type BotId, LimitsConfig } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import {
  ADE_BOT_TEMPLATES,
  type AdeBotTemplateId,
  CODER_TEMPLATE,
  FIRSTMATE_TEMPLATE,
  SECOND_MATE_TEMPLATE,
} from "./personaTemplates.ts";

const makeLayer = () => AdeBootstrap.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  return { sql, bootstrap: yield* AdeBootstrap };
});

const decodeLimitsJson = Schema.decodeEffect(Schema.fromJsonString(LimitsConfig));

it.layer(makeLayer())("AdeBootstrap.ensureSeeded", (it) => {
  it.effect("boots twice on a fresh DB: exactly one Firstmate, LimitsConfig seeded once", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;

      const first = yield* bootstrap.ensureSeeded();
      assert.isTrue(first.firstmateCreated);
      assert.isTrue(first.limitsSeeded);

      const second = yield* bootstrap.ensureSeeded();
      assert.isFalse(second.firstmateCreated);
      assert.isFalse(second.limitsSeeded);
      assert.equal(second.firstmateBotId, first.firstmateBotId);

      const bots = yield* sql<{
        bot_id: string;
        name: string;
        role_tag: string;
        active_persona_version_id: string | null;
        archived_at: string | null;
      }>`SELECT * FROM ade_bots WHERE structural_role = 'firstmate'`;
      assert.lengthOf(bots, 1);
      const firstmate = bots[0]!;
      assert.equal(firstmate.bot_id, first.firstmateBotId);
      assert.equal(firstmate.name, FIRSTMATE_TEMPLATE.defaultName);
      assert.equal(firstmate.role_tag, FIRSTMATE_TEMPLATE.roleTag);
      assert.isNull(firstmate.archived_at);

      // Shipped persona → PersonaVersion v1, active.
      const personas = yield* sql<{
        persona_version_id: string;
        content: string;
        activated_at: string | null;
      }>`SELECT * FROM ade_persona_versions WHERE bot_id = ${firstmate.bot_id}`;
      assert.lengthOf(personas, 1);
      assert.equal(personas[0]!.content, FIRSTMATE_TEMPLATE.personaContent);
      assert.isNotNull(personas[0]!.activated_at);
      assert.equal(firstmate.active_persona_version_id, personas[0]!.persona_version_id);

      // Empty memory document.
      const memory = yield* sql<{ content: string; updated_by: string }>`
        SELECT * FROM ade_memory_documents WHERE bot_id = ${firstmate.bot_id}
      `;
      assert.lengthOf(memory, 1);
      assert.equal(memory[0]!.content, "");
      // Seed writes carry system provenance, not fabricated captain edits.
      assert.equal(memory[0]!.updated_by, "system");

      // LimitsConfig singleton, seeded exactly once.
      const limits = yield* sql<{ id: number; config_json: string }>`
        SELECT * FROM ade_limits_config
      `;
      assert.lengthOf(limits, 1);
      assert.equal(limits[0]!.id, 1);
    }),
  );

  it.effect("seeds the LimitsConfig singleton with the ADR §18.1 defaults", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;
      yield* bootstrap.ensureSeeded();

      const rows = yield* sql<{ config_json: string }>`
        SELECT config_json FROM ade_limits_config WHERE id = 1
      `;
      const config = yield* decodeLimitsJson(rows[0]!.config_json);
      assert.deepEqual(config, {
        maxBots: 24,
        maxConcurrentAssignments: 16,
        maxParallelSessionsPerBot: 3,
        maxDelegationDepth: 5,
        maxQueuedAssignmentsPerBot: 20,
        maxResultSummaryLength: 16_384,
        maxConcurrentScreenboxDesktops: 4,
        screenboxIdleStopMinutes: 30,
        integrationWorkspaceRetentionDays: 7,
      });
    }),
  );
});

it.layer(makeLayer())("AdeBootstrap bot lifecycle", (it) => {
  it.effect("instantiates templates by copying content into PersonaVersion v1", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;
      yield* bootstrap.ensureSeeded();

      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      const secondCoder = yield* bootstrap.instantiateTemplate({
        templateId: "coder",
        projectId: null,
        name: "Coder Two",
      });
      assert.notEqual(coder.botId, secondCoder.botId);
      assert.notEqual(coder.personaVersionId, secondCoder.personaVersionId);

      // Content is an independent copy, one row per instantiation.
      const personas = yield* sql<{ bot_id: string; content: string }>`
        SELECT bot_id, content FROM ade_persona_versions
        WHERE persona_version_id IN (${coder.personaVersionId}, ${secondCoder.personaVersionId})
      `;
      assert.lengthOf(personas, 2);
      for (const row of personas) {
        assert.equal(row.content, CODER_TEMPLATE.personaContent);
      }

      // Shipped templates are frozen (all fields are strings, so a shallow
      // freeze suffices): a later "template edit" cannot reach through the
      // shared constant into instantiated personas.
      assert.isTrue(Object.isFrozen(CODER_TEMPLATE));
      for (const template of Object.values(ADE_BOT_TEMPLATES)) {
        assert.isTrue(Object.isFrozen(template));
      }

      const bots = yield* sql<{ structural_role: string; role_tag: string; name: string }>`
        SELECT structural_role, role_tag, name FROM ade_bots WHERE bot_id = ${secondCoder.botId}
      `;
      assert.deepEqual(bots[0], { structural_role: "crew", role_tag: "Coder", name: "Coder Two" });
    }),
  );

  it.effect("refuses to instantiate coordinator templates", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;
      yield* bootstrap.ensureSeeded();

      // Second Mates exist only via project creation; the one-click catalog
      // excludes coordinators at the type level…
      assert.isFalse("second-mate" in ADE_BOT_TEMPLATES);
      assert.isFalse("firstmate" in ADE_BOT_TEMPLATES);

      // …and the runtime guard rejects untyped callers that smuggle one in.
      const refusal = yield* Effect.flip(
        bootstrap.instantiateTemplate({
          templateId: "second-mate" as AdeBotTemplateId,
          projectId: null,
        }),
      );
      assert.equal(refusal._tag, "AdeTemplateNotInstantiableError");

      const mates = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE structural_role IN ('second-mate', 'firstmate')
      `;
      assert.equal(mates[0]!.n, 1); // only the boot-created Firstmate
    }),
  );

  it.effect("project create auto-creates its Second Mate from the shipped template", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;
      yield* bootstrap.ensureSeeded();

      const created = yield* bootstrap.createProject({
        name: "shuv2code",
        repoBinding: { path: "/repos/shuv2code", remote: "origin" },
      });

      const projects = yield* sql<{
        second_mate_bot_id: string;
        repo_path: string | null;
        integration_policy_default: string;
      }>`SELECT * FROM ade_projects WHERE project_id = ${created.projectId}`;
      assert.lengthOf(projects, 1);
      assert.equal(projects[0]!.second_mate_bot_id, created.secondMate.botId);
      assert.equal(projects[0]!.repo_path, "/repos/shuv2code");

      const mates = yield* sql<{ structural_role: string; project_id: string | null }>`
        SELECT structural_role, project_id FROM ade_bots WHERE bot_id = ${created.secondMate.botId}
      `;
      assert.deepEqual(mates[0], {
        structural_role: "second-mate",
        project_id: created.projectId,
      });

      const personas = yield* sql<{ content: string }>`
        SELECT content FROM ade_persona_versions
        WHERE persona_version_id = ${created.secondMate.personaVersionId}
      `;
      assert.equal(personas[0]!.content, SECOND_MATE_TEMPLATE.personaContent);
    }),
  );

  it.effect("refuses to archive the Firstmate; archives crew bots", () =>
    Effect.gen(function* () {
      const { sql, bootstrap } = yield* setup;
      const seeded = yield* bootstrap.ensureSeeded();

      const refusal = yield* Effect.flip(bootstrap.archiveBot(seeded.firstmateBotId));
      assert.equal(refusal._tag, "FirstmatePermanentError");

      const firstmate = yield* sql<{ archived_at: string | null }>`
        SELECT archived_at FROM ade_bots WHERE bot_id = ${seeded.firstmateBotId}
      `;
      assert.isNull(firstmate[0]!.archived_at);

      const reviewer = yield* bootstrap.instantiateTemplate({
        templateId: "reviewer",
        projectId: null,
      });
      yield* bootstrap.archiveBot(reviewer.botId);
      const archived = yield* sql<{ archived_at: string | null }>`
        SELECT archived_at FROM ade_bots WHERE bot_id = ${reviewer.botId}
      `;
      assert.isNotNull(archived[0]!.archived_at);

      const missing = yield* Effect.flip(bootstrap.archiveBot("nope" as BotId));
      assert.equal(missing._tag, "AdeBotNotFoundError");
    }),
  );
});
