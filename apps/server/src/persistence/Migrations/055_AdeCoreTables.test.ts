import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_AdeCoreTables", (it) => {
  it.effect("boots the full manifest on an empty database; a second boot is a no-op", () =>
    Effect.gen(function* () {
      const first = yield* runMigrations();
      assert.isAtLeast(first.length, 55);
      assert.deepEqual(first[first.length - 1], [55, "AdeCoreTables"]);

      const second = yield* runMigrations();
      assert.deepEqual(second, []);
    }),
  );

  it.effect("persists one row per ADE entity across the table graph", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`PRAGMA foreign_keys = ON`;

      yield* sql`
        INSERT INTO ade_projects (
          project_id, name, second_mate_bot_id, repo_path, repo_remote,
          integration_policy_default, check_commands_json, shared_specialist_allow_list_json,
          limits_overrides_json, created_at, updated_at
        ) VALUES ('project-1', 'shuv2code', 'bot-secondmate', '/repos/shuv2code', 'origin',
                  'agent-review', '["vp check"]', '"all"',
                  NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_bots (
          bot_id, name, display_meta_json, structural_role, role_tag,
          project_id, active_persona_version_id, computer_use, created_at, archived_at
        ) VALUES
          ('bot-firstmate', 'Firstmate', NULL, 'firstmate', 'Coordinator',
           NULL, 'persona-1', 0, '2026-08-24T00:00:00.000Z', NULL),
          ('bot-secondmate', 'Mate', NULL, 'second-mate', 'Coordinator',
           'project-1', NULL, 0, '2026-08-24T00:00:00.000Z', NULL),
          ('bot-coder', 'Coder', '{"emoji":"🛠️"}', 'crew', 'Coder',
           'project-1', NULL, 1, '2026-08-24T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO ade_persona_versions (persona_version_id, bot_id, content, created_at, activated_at)
        VALUES ('persona-1', 'bot-firstmate', 'You are the Firstmate.', '2026-08-24T00:00:00.000Z', '2026-08-24T00:05:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_memory_documents (bot_id, content, updated_at, updated_by)
        VALUES ('bot-firstmate', 'Prefers concise updates.', '2026-08-24T00:00:00.000Z', 'captain')
      `;
      yield* sql`
        INSERT INTO ade_bot_execution_bindings (
          binding_id, bot_id, engine, kernel_session_id, purpose, status, created_at, updated_at
        ) VALUES ('binding-1', 'bot-coder', 'shuvcode', 'sess-1', 'primary-text', 'active',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_assignments (
          assignment_id, idempotency_key, requester_kind, requester_bot_id,
          recipient_bot_id, project_id, instruction, declared_risk, parent_assignment_id,
          status, blocked_reason, queue_position, result_json, delivered, delivered_at,
          created_at, updated_at
        ) VALUES ('assignment-1', 'toolcall-1', 'bot', 'bot-secondmate',
                  'bot-coder', 'project-1', 'Implement the widget', 'normal', NULL,
                  'completed', NULL, 0,
                  '{"status":"completed","summary":"done","artifacts":[]}', 1,
                  '2026-08-24T01:00:00.000Z',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T01:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, gate, reviewer_bot_id, workspace_path,
          bounce_count, bounce_json, repair_assignment_id, created_at, updated_at
        ) VALUES ('candidate-1', 'project-1', 'assignment-1', '["assignment-1"]',
                  '["zkmqwpxr"]', 'bot-coder', 'normal', 'running', NULL, NULL, NULL,
                  0, NULL, NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, stack_url,
          native_stack_number, native_stack_node_id, created_at, updated_at
        ) VALUES ('stack-1', 'project-1', 'native-stack', 'building', NULL,
                  NULL, NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_publication_layers (
          publication_layer_id, publication_stack_id, layer_order, change_ids_json,
          bookmark_name, pr_number, head_sha, submitted_sha, merge_sha, pr_state, status,
          created_at, updated_at
        ) VALUES ('layer-1', 'stack-1', 0, '["zkmqwpxr"]',
                  'ade/publish/stack-1/layer-1', 158, NULL, NULL, NULL, 'open', 'submitted',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_screenbox_provisionings (
          bot_id, status, container_ref, volume_ref, created_at, last_needed_at
        ) VALUES ('bot-coder', 'running', 'screenbox-bot-coder', 'vol-bot-coder',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T02:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_needs_you_items (
          needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
        ) VALUES ('needsyou-1', 'approval', '[{"_tag":"assignment","assignmentId":"assignment-1"}]',
                  'open', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO ade_limits_config (id, config_json, updated_at)
        VALUES (1, '{"maxBots":24}', '2026-08-24T00:00:00.000Z')
      `;

      const counts = yield* sql<{ readonly tbl: string; readonly n: number }>`
        SELECT 'bots' AS tbl, COUNT(*) AS n FROM ade_bots
        UNION ALL SELECT 'assignments', COUNT(*) FROM ade_assignments
        UNION ALL SELECT 'candidates', COUNT(*) FROM ade_integration_candidates
        UNION ALL SELECT 'layers', COUNT(*) FROM ade_publication_layers
        ORDER BY tbl
      `;
      assert.deepEqual(counts, [
        { tbl: "assignments", n: 1 },
        { tbl: "bots", n: 3 },
        { tbl: "candidates", n: 1 },
        { tbl: "layers", n: 1 },
      ]);
    }),
  );

  it.effect("enforces ADE invariants declared in the schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`
        INSERT INTO ade_projects (
          project_id, name, second_mate_bot_id, integration_policy_default,
          created_at, updated_at
        ) VALUES ('project-inv', 'p', 'bot-inv', 'automatic',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
        VALUES ('bot-inv', 'Inv', 'crew', 'Coder', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-inv-1', 'project-inv', 'inv-1', '[]', '[]', 'bot-inv',
                  'normal', 'running',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // One running integration candidate per project (ADR §16.2).
      const secondRunning = yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-inv-2', 'project-inv', 'inv-2', '[]', '[]', 'bot-inv',
                  'normal', 'running',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.strictEqual(secondRunning._tag, "SqlError");

      // A settled candidate frees the running slot for the next queue head.
      yield* sql`
        UPDATE ade_integration_candidates SET status = 'integrated'
        WHERE integration_candidate_id = 'candidate-inv-1'
      `;
      yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-inv-3', 'project-inv', 'inv-3', '[]', '[]', 'bot-inv',
                  'mechanical', 'running',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // Enqueue idempotency is per project (spec §4.4).
      const replayedCandidate = yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-inv-4', 'project-inv', 'inv-3', '[]', '[]', 'bot-inv',
                  'normal', 'queued',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.strictEqual(replayedCandidate._tag, "SqlError");

      // ...but a settled candidate must not burn its key: the repaired change
      // comes back under the same tool-call-derived key and has to queue again.
      yield* sql`
        UPDATE ade_integration_candidates SET status = 'bounced'
        WHERE integration_candidate_id = 'candidate-inv-3'
      `;
      yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-inv-5', 'project-inv', 'inv-3', '[]', '[]', 'bot-inv',
                  'normal', 'queued',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      yield* sql`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, created_at, updated_at
        ) VALUES ('stack-inv-1', 'project-inv', 'chained', 'review-frozen',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // One active publication stack per project (ADR §8.3).
      const secondActiveStack = yield* sql`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, created_at, updated_at
        ) VALUES ('stack-inv-2', 'project-inv', 'chained', 'building',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.strictEqual(secondActiveStack._tag, "SqlError");

      // A merged stack no longer blocks a new active stack.
      yield* sql`
        UPDATE ade_publication_stacks SET status = 'merged'
        WHERE publication_stack_id = 'stack-inv-1'
      `;
      yield* sql`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, created_at, updated_at
        ) VALUES ('stack-inv-3', 'project-inv', 'native-stack', 'building',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // A bot requester must carry its bot id; a captain requester must not.
      const inconsistentRequester = yield* sql`
        INSERT INTO ade_assignments (
          assignment_id, idempotency_key, requester_kind, requester_bot_id,
          recipient_bot_id, instruction, declared_risk, status, queue_position,
          created_at, updated_at
        ) VALUES ('assignment-inv', 'key-inv', 'captain', 'bot-inv',
                  'bot-inv', 'do', 'normal', 'queued', 0,
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.strictEqual(inconsistentRequester._tag, "SqlError");
    }),
  );

  it.effect("scopes assignment idempotency keys per requester (ADR §13.6)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
        VALUES
          ('bot-idem-a', 'A', 'crew', 'Coder', '2026-08-24T00:00:00.000Z'),
          ('bot-idem-b', 'B', 'crew', 'Coder', '2026-08-24T00:00:00.000Z')
      `;
      const insert = (id: string, kind: string, requesterBotId: string | null) => sql`
        INSERT INTO ade_assignments (
          assignment_id, idempotency_key, requester_kind, requester_bot_id,
          recipient_bot_id, instruction, declared_risk, status, queue_position,
          created_at, updated_at
        ) VALUES (${id}, 'shared-key', ${kind}, ${requesterBotId},
                  'bot-idem-a', 'do', 'normal', 'queued', 0,
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // The same key from different requesters is fine.
      yield* insert("asg-idem-1", "bot", "bot-idem-a");
      yield* insert("asg-idem-2", "bot", "bot-idem-b");
      yield* insert("asg-idem-3", "captain", null);

      // A replay by the same requester is rejected — including the captain,
      // whose NULL requester_bot_id is folded by the COALESCE in the index.
      const botReplay = yield* insert("asg-idem-4", "bot", "bot-idem-a").pipe(Effect.flip);
      assert.strictEqual(botReplay._tag, "SqlError");
      const captainReplay = yield* insert("asg-idem-5", "captain", null).pipe(Effect.flip);
      assert.strictEqual(captainReplay._tag, "SqlError");
    }),
  );

  it.effect("enforces at most one Firstmate bot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const existing = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE structural_role = 'firstmate'
      `;
      if (existing[0]?.n === 0) {
        yield* sql`
          INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
          VALUES ('bot-fm-anchor', 'Firstmate', 'firstmate', 'Coordinator', '2026-08-24T00:00:00.000Z')
        `;
      }

      const secondFirstmate = yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
        VALUES ('bot-fm-dupe', 'Impostor', 'firstmate', 'Coordinator', '2026-08-24T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.strictEqual(secondFirstmate._tag, "SqlError");

      // Other structural roles stay unconstrained.
      yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, created_at)
        VALUES ('bot-fm-crew', 'Crew', 'crew', 'Coder', '2026-08-24T00:00:00.000Z')
      `;
    }),
  );

  it.effect("hard-delete paths cascade and detach cross-bot lineage (spec §4.6)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`PRAGMA foreign_keys = ON`;

      yield* sql`
        INSERT INTO ade_projects (
          project_id, name, second_mate_bot_id, integration_policy_default,
          created_at, updated_at
        ) VALUES ('proj-del', 'p', 'bot-del-mate', 'automatic',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, project_id, created_at)
        VALUES
          ('bot-del-mate', 'Mate', 'second-mate', 'Coordinator', 'proj-del', '2026-08-24T00:00:00.000Z'),
          ('bot-del-worker', 'Worker', 'crew', 'Coder', 'proj-del', '2026-08-24T00:00:00.000Z'),
          ('bot-del-keep', 'Keeper', 'workspace-specialist', 'Researcher', NULL, '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_persona_versions (persona_version_id, bot_id, content, created_at)
        VALUES ('persona-del', 'bot-del-worker', 'persona', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_memory_documents (bot_id, content, updated_at, updated_by)
        VALUES ('bot-del-worker', 'memory', '2026-08-24T00:00:00.000Z', 'bot')
      `;
      yield* sql`
        INSERT INTO ade_bot_execution_bindings (
          binding_id, bot_id, engine, kernel_session_id, purpose, status, created_at, updated_at
        ) VALUES ('binding-del', 'bot-del-worker', 'shuvcode', 'sess-del', 'primary-text', 'active',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_screenbox_provisionings (bot_id, status, created_at)
        VALUES ('bot-del-worker', 'running', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_assignments (
          assignment_id, idempotency_key, requester_kind, requester_bot_id,
          recipient_bot_id, project_id, instruction, declared_risk, parent_assignment_id,
          status, queue_position, created_at, updated_at
        ) VALUES
          ('asg-del-parent', 'key-del-1', 'bot', 'bot-del-mate',
           'bot-del-worker', 'proj-del', 'do', 'normal', NULL,
           'running', 0, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'),
          ('asg-del-child', 'key-del-2', 'bot', 'bot-del-worker',
           'bot-del-keep', NULL, 'research', 'normal', 'asg-del-parent',
           'queued', 0, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_integration_candidates (
          integration_candidate_id, project_id, idempotency_key,
          source_assignment_ids_json, change_ids_json, originating_bot_id,
          declared_risk, status, created_at, updated_at
        ) VALUES ('candidate-del', 'proj-del', 'del-1', '[]', '[]', 'bot-del-worker',
                  'normal', 'queued',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO ade_publication_stacks (
          publication_stack_id, project_id, mode, status, created_at, updated_at
        ) VALUES ('stack-del', 'proj-del', 'chained', 'building',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;

      // Bot hard-delete: assignments received, persona, memory, bindings, and
      // the Screenbox record cascade; the other bot's child assignment
      // survives with its lineage pointer nulled and its (now-deleted)
      // requester preserved as forensic history.
      yield* sql`DELETE FROM ade_bots WHERE bot_id = 'bot-del-worker'`;
      const afterBotDelete = yield* sql<{
        readonly assignmentId: string;
        readonly parentAssignmentId: string | null;
        readonly requesterBotId: string | null;
      }>`
        SELECT
          assignment_id AS "assignmentId",
          parent_assignment_id AS "parentAssignmentId",
          requester_bot_id AS "requesterBotId"
        FROM ade_assignments
        WHERE assignment_id IN ('asg-del-parent', 'asg-del-child')
      `;
      assert.deepEqual(afterBotDelete, [
        {
          assignmentId: "asg-del-child",
          parentAssignmentId: null,
          requesterBotId: "bot-del-worker",
        },
      ]);
      const orphans = yield* sql<{ readonly n: number }>`
        SELECT
          (SELECT COUNT(*) FROM ade_persona_versions WHERE bot_id = 'bot-del-worker')
          + (SELECT COUNT(*) FROM ade_memory_documents WHERE bot_id = 'bot-del-worker')
          + (SELECT COUNT(*) FROM ade_bot_execution_bindings WHERE bot_id = 'bot-del-worker')
          + (SELECT COUNT(*) FROM ade_screenbox_provisionings WHERE bot_id = 'bot-del-worker')
          AS n
      `;
      assert.strictEqual(orphans[0]?.n, 0);

      // Project hard-delete: crew bots, integration candidates, and
      // publication stacks cascade.
      yield* sql`DELETE FROM ade_projects WHERE project_id = 'proj-del'`;
      const afterProjectDelete = yield* sql<{ readonly n: number }>`
        SELECT
          (SELECT COUNT(*) FROM ade_bots WHERE project_id = 'proj-del')
          + (SELECT COUNT(*) FROM ade_integration_candidates WHERE project_id = 'proj-del')
          + (SELECT COUNT(*) FROM ade_publication_stacks WHERE project_id = 'proj-del')
          AS n
      `;
      assert.strictEqual(afterProjectDelete[0]?.n, 0);
      const keeper = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE bot_id = 'bot-del-keep'
      `;
      assert.strictEqual(keeper[0]?.n, 1);
    }),
  );
});
