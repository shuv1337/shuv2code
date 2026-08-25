/**
 * ADE-owned tables on the fresh database (ADR §17.3 — no alpha migration).
 * One table per `docs/ade/ADE-V1-SPEC.md` §2 entity; row shapes mirror the
 * schemas in `@shuv2code/contracts` `ade.ts`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Spec §2.1 — durable, engine-neutral bot identity. The Firstmate
  // permanence rule is service-level. active_persona_version_id is not a
  // foreign key: persona versions already point at their bot, and the
  // bot/persona reference cycle would otherwise block inserts. project_id
  // references ade_projects (created below — SQLite resolves foreign keys at
  // DML time), so a confirm-gated project delete removes its crew.
  yield* sql`
    CREATE TABLE ade_bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_meta_json TEXT,
      structural_role TEXT NOT NULL CHECK (
        structural_role IN ('firstmate', 'second-mate', 'crew', 'workspace-specialist')
      ),
      role_tag TEXT NOT NULL,
      project_id TEXT,
      active_persona_version_id TEXT,
      computer_use INTEGER NOT NULL DEFAULT 0 CHECK (computer_use IN (0, 1)),
      created_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (project_id) REFERENCES ade_projects(project_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_ade_bots_project
    ON ade_bots(project_id, structural_role)
  `;
  // Exactly one Firstmate ever exists (spec §2.1); makes the bootstrap
  // ensure-Firstmate step (S3, #157) race-proof at the schema level.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bots_single_firstmate
    ON ade_bots(structural_role)
    WHERE structural_role = 'firstmate'
  `;

  // Spec §2.1 / ADR §12.1 — versioned captain-authored persona content.
  yield* sql`
    CREATE TABLE ade_persona_versions (
      persona_version_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      FOREIGN KEY (bot_id) REFERENCES ade_bots(bot_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_ade_persona_versions_bot
    ON ade_persona_versions(bot_id, created_at)
  `;

  // Spec §2.1 / ADR §12.2 — one bounded memory document per bot (1:1).
  // The CHECK counts code points while the contracts bound counts UTF-16
  // code units — the DB is deliberately the looser backstop; the service
  // enforces the strict bound. (Pre-release in-place edit on ade-v1.)
  yield* sql`
    CREATE TABLE ade_memory_documents (
      bot_id TEXT PRIMARY KEY,
      content TEXT NOT NULL CHECK (length(content) <= 65536),
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL CHECK (updated_by IN ('bot', 'captain', 'system')),
      FOREIGN KEY (bot_id) REFERENCES ade_bots(bot_id) ON DELETE CASCADE
    )
  `;

  // Spec §2.1 / ADR §3.1–§3.2 — replaceable kernel-session bindings.
  // rollover_summary is the bounded outgoing-session summary (ADR §12.3,
  // ≤16 KB per ADR §18.1) recorded on a binding when it is closed/rolled over;
  // it seeds component 4 of the replacement session's projection.
  yield* sql`
    CREATE TABLE ade_bot_execution_bindings (
      binding_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('shuvcode', 'codex')),
      kernel_session_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (
        purpose IN ('primary-text', 'parallel-work', 'voice', 'specialized-work')
      ),
      status TEXT NOT NULL CHECK (status IN ('active', 'historical', 'lost')),
      rollover_summary TEXT CHECK (
        rollover_summary IS NULL OR length(rollover_summary) <= 16384
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES ade_bots(bot_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bot_execution_bindings_session
    ON ade_bot_execution_bindings(engine, kernel_session_id)
  `;
  yield* sql`
    CREATE INDEX idx_ade_bot_execution_bindings_bot
    ON ade_bot_execution_bindings(bot_id, status)
  `;
  // ADR §3.2 — each bot has at most one *active primary text* session; makes
  // the session/rollover service (S8, #162) race-proof at the schema level,
  // exactly like idx_ade_bots_single_firstmate does for the bootstrap.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_bot_execution_bindings_one_active_primary
    ON ade_bot_execution_bindings(bot_id)
    WHERE purpose = 'primary-text' AND status = 'active'
  `;

  // Spec §2.3 / ADR §6, §7, §14 — projects. second_mate_bot_id is not a
  // foreign key: project and Second Mate reference each other, and with a
  // foreign key on both sides neither row could be inserted first.
  yield* sql`
    CREATE TABLE ade_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      second_mate_bot_id TEXT NOT NULL,
      repo_path TEXT,
      repo_remote TEXT CHECK (repo_remote IS NULL OR repo_path IS NOT NULL),
      integration_policy_default TEXT NOT NULL CHECK (
        integration_policy_default IN ('automatic', 'agent-review', 'human-approval')
      ),
      check_commands_json TEXT NOT NULL DEFAULT '[]',
      shared_specialist_allow_list_json TEXT NOT NULL DEFAULT '"all"',
      limits_overrides_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Spec §2.2 / ADR §13 — durable first-class assignments. The idempotency
  // key is unique per requester for idempotent creation (§13.6);
  // delivered/delivered_at is the exactly-once-at-product-level delivery
  // record; queue_position backs per-bot FIFO with explicit reorder (§13.2).
  // Delete paths follow the confirm-gated hard-delete graph (spec §4.6):
  // deleting a bot removes the assignments it received, deleting a project
  // removes its assignments, and deleting a parent assignment detaches its
  // children (a child may belong to a different bot, so lineage never
  // cross-cascades). requester_bot_id deliberately has no foreign key:
  // captain rows carry no bot id, and rows whose requesting bot was deleted
  // are tolerated as forensic history — SET NULL would violate the
  // kind/bot-id consistency CHECK.
  yield* sql`
    CREATE TABLE ade_assignments (
      assignment_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      requester_kind TEXT NOT NULL CHECK (requester_kind IN ('bot', 'captain')),
      requester_bot_id TEXT CHECK (
        (requester_kind = 'bot') = (requester_bot_id IS NOT NULL)
      ),
      recipient_bot_id TEXT NOT NULL,
      project_id TEXT,
      instruction TEXT NOT NULL,
      declared_risk TEXT NOT NULL CHECK (declared_risk IN ('mechanical', 'normal', 'protected')),
      parent_assignment_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')
      ),
      blocked_reason TEXT CHECK (
        blocked_reason IS NULL
        OR blocked_reason IN ('approval', 'children', 'needs-resume', 'kernel-down')
      ),
      queue_position INTEGER NOT NULL CHECK (queue_position >= 0),
      result_json TEXT,
      delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
      delivered_at TEXT,
      -- Assignment-engine delivery state machine (S7, #161). delivered /
      -- delivered_at stay the product-level delivery record from the
      -- contracts schema; these two columns are how the engine gets there
      -- exactly once: a batch is claimed ('delivering' + a durable
      -- delivery_attempt_id committed BEFORE the kernel call), then marked
      -- 'delivered'. A crash in that window leaves the batch 'delivering',
      -- and recovery re-drives it with the same attempt id so the kernel
      -- port can dedupe. 'not-applicable' marks captain-requested results,
      -- which surface on the client instead of as synthetic input.
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        delivery_state IN ('pending', 'delivering', 'delivered', 'not-applicable')
      ),
      delivery_attempt_id TEXT,
      -- Lease bookkeeping for the claim above: when the current attempt was
      -- taken and how many attempts it has had. A claimed batch is only ever
      -- re-driven (never re-keyed), so recovery leases it by age with a
      -- bounded backoff instead of racing the live sender.
      delivery_claimed_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      -- Snapshot of the parental wait the claim was made under. Recovery
      -- replays exactly what was claimed instead of re-deriving a wait from
      -- current row shape, which could release a *later* wait over different
      -- children. Deliberately not a foreign key: it is claim history, and a
      -- deleted parent simply makes the release match nothing.
      delivery_parent_assignment_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (recipient_bot_id) REFERENCES ade_bots(bot_id) ON DELETE CASCADE,
      FOREIGN KEY (parent_assignment_id)
        REFERENCES ade_assignments(assignment_id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES ade_projects(project_id) ON DELETE CASCADE
    )
  `;
  // Idempotency keys are tool-call scoped, so uniqueness is per requester
  // (ADR §13.6). COALESCE folds the captain's NULL requester_bot_id into a
  // sentinel because SQLite unique indexes treat NULLs as distinct — without
  // it, duplicate captain-issued keys would slip through.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_assignments_idempotency
    ON ade_assignments(requester_kind, COALESCE(requester_bot_id, ''), idempotency_key)
  `;
  yield* sql`
    CREATE INDEX idx_ade_assignments_recipient_queue
    ON ade_assignments(recipient_bot_id, status, queue_position)
  `;
  yield* sql`
    CREATE INDEX idx_ade_assignments_parent
    ON ade_assignments(parent_assignment_id)
  `;

  // Spec §2.3 / ADR §7.2, §16.2 — serialized integration queue. One running
  // candidate per project, enforced with a partial unique index; restart
  // re-runs the queue head, so no per-step journal exists.
  //
  // `gate`, `reviewer_bot_id`, and `workspace_path` are recomputed from scratch
  // on every queue-head pass — they are rendering state for the captain
  // surfaces, deliberately *not* a resume journal (ADR §16.2). Bot references
  // carry no foreign key for the same reason `ade_assignments.requester_bot_id`
  // does not: a bounced candidate stays readable as forensic history after its
  // author or reviewer is deleted. (Pre-release in-place edit on ade-v1.)
  yield* sql`
    CREATE TABLE ade_integration_candidates (
      integration_candidate_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      source_assignment_ids_json TEXT NOT NULL,
      change_ids_json TEXT NOT NULL,
      originating_bot_id TEXT NOT NULL,
      declared_risk TEXT NOT NULL CHECK (declared_risk IN ('mechanical', 'normal', 'protected')),
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'awaiting-review', 'awaiting-approval', 'integrated', 'bounced')
      ),
      gate TEXT CHECK (
        gate IS NULL OR gate IN ('automatic', 'agent-review', 'human-approval')
      ),
      reviewer_bot_id TEXT,
      workspace_path TEXT,
      -- The gate verdict is durable and is applied by the pass, not by the
      -- caller: an approval parks the row back on 'running' under this column,
      -- so a crash mid-integration converges on restart instead of stranding
      -- the project queue on a gate nobody will answer again.
      verdict TEXT CHECK (verdict IS NULL OR verdict IN ('approved', 'rejected')),
      verdict_at TEXT,
      verdict_by_bot_id TEXT,
      verdict_detail TEXT,
      -- Lease over the running slot. The partial unique index stops two rows
      -- from running; the lease stops two workers from adopting the *same*
      -- running row (and sharing one workspace directory). A pass refreshes it
      -- as it goes and re-asserts it immediately before canonical advancement.
      lease_holder TEXT,
      lease_expires_at TEXT,
      -- Order-insensitive canonical form of change_ids_json, so repeat-bounce
      -- detection sees ["a","b"] and ["b","a"] as the same change set.
      change_ids_key TEXT NOT NULL DEFAULT '',
      bounce_count INTEGER NOT NULL DEFAULT 0,
      bounce_json TEXT,
      repair_assignment_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES ade_projects(project_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_integration_candidates_one_running
    ON ade_integration_candidates(project_id)
    WHERE status = 'running'
  `;
  // Enqueue idempotency is per project (the queue is per project), mirroring
  // the per-requester assignment key (ADR §13.6) — but scoped to *live* rows.
  // A settled candidate must not burn its key: after a bounce, the repaired
  // change is re-submitted under the same tool-call-derived key and has to
  // produce a fresh candidate rather than silently returning the old corpse.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_integration_candidates_idempotency
    ON ade_integration_candidates(project_id, idempotency_key)
    WHERE status NOT IN ('integrated', 'bounced')
  `;
  yield* sql`
    CREATE INDEX idx_ade_integration_candidates_change_set
    ON ade_integration_candidates(project_id, change_ids_key, status)
  `;
  yield* sql`
    CREATE INDEX idx_ade_integration_candidates_queue
    ON ade_integration_candidates(project_id, status, created_at)
  `;

  // Spec §2.4 / ADR §8.3 — one active publication stack per project.
  yield* sql`
    CREATE TABLE ade_publication_stacks (
      publication_stack_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('native-stack', 'chained')),
      status TEXT NOT NULL CHECK (
        status IN ('building', 'review-frozen', 'merging', 'merged', 'reconciled')
      ),
      stack_url TEXT,
      native_stack_number INTEGER,
      native_stack_node_id TEXT,
      -- The branch the bottom layer targets. Persisted rather than assumed so a
      -- project whose canonical bookmark is not 'main' still publishes onto the
      -- branch its integration service advances (ADR §6.3, §8.3).
      base_bookmark TEXT NOT NULL DEFAULT 'main',
      -- Concurrency guard over the whole pass. Publication passes talk to
      -- GitHub, so two overlapping sweeps would create duplicate PRs; the lease
      -- is what makes "one pass at a time" true rather than hoped for.
      lease_holder TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES ade_projects(project_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_publication_stacks_one_active
    ON ade_publication_stacks(project_id)
    WHERE status IN ('building', 'review-frozen', 'merging')
  `;

  // Spec §2.4 — layers. pr_number is mutable (adopt-by-head-branch fallback);
  // post-merge logic keys on the recorded SHAs, never on change ids.
  yield* sql`
    CREATE TABLE ade_publication_layers (
      publication_layer_id TEXT PRIMARY KEY,
      publication_stack_id TEXT NOT NULL,
      layer_order INTEGER NOT NULL CHECK (layer_order >= 0),
      change_ids_json TEXT NOT NULL,
      bookmark_name TEXT NOT NULL,
      pr_number INTEGER CHECK (pr_number IS NULL OR pr_number >= 1),
      head_sha TEXT,
      submitted_sha TEXT,
      merge_sha TEXT,
      pr_state TEXT CHECK (pr_state IS NULL OR pr_state IN ('open', 'closed', 'merged')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'merged')),
      -- The integrated candidate this layer represents, when the layer was
      -- adopted from the integration queue. It is the deterministic idempotency
      -- key for that adoption: a re-running pass must not append a second layer
      -- for a candidate it already published.
      integration_candidate_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (publication_stack_id)
        REFERENCES ade_publication_stacks(publication_stack_id) ON DELETE CASCADE,
      FOREIGN KEY (integration_candidate_id)
        REFERENCES ade_integration_candidates(integration_candidate_id) ON DELETE SET NULL
    )
  `;
  // SQLite has no deferrable unique constraints, so the publication service
  // (S11) must stage layer_order swaps through a temporary offset instead of
  // exchanging two orders in place.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_publication_layers_order
    ON ade_publication_layers(publication_stack_id, layer_order)
  `;
  // One layer per candidate per stack — the DB half of adoption idempotency.
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_publication_layers_candidate
    ON ade_publication_layers(publication_stack_id, integration_candidate_id)
    WHERE integration_candidate_id IS NOT NULL
  `;
  // Adopt-by-head-branch is a *lookup*, so the branch name has to be unique
  // within a stack; two layers sharing one branch would make the adopted PR
  // ambiguous (spec §4.5 invariant 2).
  yield* sql`
    CREATE UNIQUE INDEX idx_ade_publication_layers_bookmark
    ON ade_publication_layers(publication_stack_id, bookmark_name)
  `;

  // Spec §2.5 / ADR §3.5 — durable provisioning record, botId-keyed for
  // idempotency (desktop id = botId, spec §4.6).
  yield* sql`
    CREATE TABLE ade_screenbox_provisionings (
      bot_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('provisioning', 'running', 'stopped', 'failed')),
      container_ref TEXT,
      volume_ref TEXT,
      created_at TEXT NOT NULL,
      last_needed_at TEXT,
      FOREIGN KEY (bot_id) REFERENCES ade_bots(bot_id) ON DELETE CASCADE
    )
  `;

  // Spec §2.5 — one durable Needs You item; renderings are derived (spec §7).
  yield* sql`
    CREATE TABLE ade_needs_you_items (
      needs_you_item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (
        kind IN ('approval', 'kernel-down', 'stall', 'provision-failure', 'form')
      ),
      subject_refs_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_ade_needs_you_items_open
    ON ade_needs_you_items(status, created_at)
  `;

  // Spec §2.5 / ADR §18.1 — singleton captain-tunable limits, stored as the
  // encoded LimitsConfig document. Seeding at first boot is the bootstrap
  // service's job (S3, #157), not a migration concern.
  yield* sql`
    CREATE TABLE ade_limits_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
