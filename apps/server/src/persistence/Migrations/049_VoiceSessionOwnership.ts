import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite follows renamed tables through foreign keys. Rebuild the complete
  // transport -> action -> mutation chain so no child is ever left pointing at
  // the temporary legacy parent.
  yield* sql`ALTER TABLE voice_transport_sessions RENAME TO voice_transport_sessions_legacy`;
  yield* sql`
    CREATE TABLE voice_transport_sessions (
      transport_session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      controller_thread_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL
        CHECK (owner_kind IN ('controller', 'thread', 'transcription')),
      owner_id TEXT NOT NULL,
      anchor_thread_id TEXT,
      transport_thread_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      realtime_session_id TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('negotiating', 'active', 'closing', 'closed', 'failed', 'fenced')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      CHECK (
        (owner_kind = 'transcription' AND anchor_thread_id IS NOT NULL)
        OR
        (owner_kind <> 'transcription' AND anchor_thread_id IS NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO voice_transport_sessions (
      transport_session_id,
      environment_id,
      controller_thread_id,
      owner_kind,
      owner_id,
      anchor_thread_id,
      transport_thread_id,
      runtime_instance_id,
      generation,
      realtime_session_id,
      state,
      created_at,
      updated_at,
      closed_at
    )
    SELECT
      transport_session_id,
      environment_id,
      controller_thread_id,
      'controller',
      controller_thread_id,
      NULL,
      transport_thread_id,
      runtime_instance_id,
      generation,
      realtime_session_id,
      state,
      created_at,
      updated_at,
      closed_at
    FROM voice_transport_sessions_legacy
  `;

  yield* sql`ALTER TABLE voice_controller_actions RENAME TO voice_controller_actions_legacy`;
  yield* sql`
    CREATE TABLE voice_controller_actions (
      voice_action_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      controller_thread_id TEXT NOT NULL,
      transport_session_id TEXT NOT NULL,
      transport_runtime_instance_id TEXT NOT NULL,
      transport_generation INTEGER NOT NULL CHECK (transport_generation >= 1),
      handoff_id TEXT NOT NULL,
      handoff_item_id TEXT NOT NULL,
      client_user_message_id TEXT NOT NULL,
      controller_runtime_instance_id TEXT NOT NULL,
      controller_provider_session_id TEXT,
      controller_provider_turn_id TEXT,
      claimed_mutation_key TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('queued', 'active', 'completed', 'cancelled', 'failed', 'expired')),
      created_at TEXT NOT NULL,
      controller_turn_bound_at TEXT,
      closed_at TEXT,
      UNIQUE (transport_session_id, handoff_id, handoff_item_id),
      CHECK (client_user_message_id = voice_action_id),
      CHECK (
        (controller_provider_session_id IS NULL AND controller_provider_turn_id IS NULL
          AND controller_turn_bound_at IS NULL)
        OR
        (controller_provider_session_id IS NOT NULL AND controller_provider_turn_id IS NOT NULL
          AND controller_turn_bound_at IS NOT NULL)
      ),
      FOREIGN KEY (transport_session_id)
        REFERENCES voice_transport_sessions(transport_session_id)
    )
  `;
  yield* sql`
    INSERT INTO voice_controller_actions
    SELECT * FROM voice_controller_actions_legacy
  `;

  yield* sql`ALTER TABLE voice_controller_mutations RENAME TO voice_controller_mutations_legacy`;
  yield* sql`
    CREATE TABLE voice_controller_mutations (
      voice_action_id TEXT PRIMARY KEY,
      mutation_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      semantic_slot TEXT NOT NULL,
      canonical_request_hash TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      provider_creation_id TEXT,
      binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
      control_epoch INTEGER NOT NULL CHECK (control_epoch >= 0),
      dispatch_state TEXT NOT NULL
        CHECK (
          dispatch_state IN (
            'never_dispatched',
            'claimed',
            'dispatched',
            'confirmed',
            'failed',
            'indeterminate',
            'stale',
            'cancelled_by_policy'
          )
        ),
      claim_owner TEXT,
      claim_expires_at TEXT,
      claimed_at TEXT,
      dispatch_started_at TEXT,
      provider_acknowledged_at TEXT,
      outcome_at TEXT,
      sanitized_outcome TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (tool_name = 'thread_create' AND provider_creation_id IS NOT NULL)
        OR
        (tool_name <> 'thread_create' AND provider_creation_id IS NULL)
      ),
      FOREIGN KEY (voice_action_id)
        REFERENCES voice_controller_actions(voice_action_id)
    )
  `;
  yield* sql`
    INSERT INTO voice_controller_mutations
    SELECT * FROM voice_controller_mutations_legacy
  `;

  yield* sql`DROP TABLE voice_controller_mutations_legacy`;
  yield* sql`DROP TABLE voice_controller_actions_legacy`;
  yield* sql`DROP TABLE voice_transport_sessions_legacy`;

  // Migration 042 permitted one open lease per controller. When more than one
  // controller exists in an environment, retain the newest lease and fence the
  // rest before installing the stricter environment-level invariant.
  yield* sql`
    WITH ranked AS (
      SELECT
        transport_session_id,
        ROW_NUMBER() OVER (
          PARTITION BY environment_id
          ORDER BY updated_at DESC, created_at DESC, transport_session_id DESC
        ) AS environment_rank
      FROM voice_transport_sessions
      WHERE state IN ('negotiating', 'active', 'closing')
    )
    UPDATE voice_transport_sessions
    SET
      state = 'fenced',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE transport_session_id IN (
      SELECT transport_session_id
      FROM ranked
      WHERE environment_rank > 1
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_voice_transport_sessions_one_open_environment
    ON voice_transport_sessions(environment_id)
    WHERE state IN ('negotiating', 'active', 'closing')
  `;
  yield* sql`
    CREATE INDEX idx_voice_transport_sessions_owner
    ON voice_transport_sessions(environment_id, owner_kind, owner_id, generation DESC)
  `;
  yield* sql`
    CREATE INDEX idx_voice_transport_sessions_controller_compat
    ON voice_transport_sessions(controller_thread_id, generation DESC)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_voice_controller_actions_provider_turn
    ON voice_controller_actions(
      controller_thread_id,
      controller_provider_session_id,
      controller_provider_turn_id
    )
    WHERE controller_provider_session_id IS NOT NULL
      AND controller_provider_turn_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX idx_voice_controller_actions_transport_generation
    ON voice_controller_actions(transport_session_id, transport_generation, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_voice_controller_mutations_recovery
    ON voice_controller_mutations(dispatch_state, claim_expires_at, updated_at)
  `;
  yield* sql`
    CREATE INDEX idx_voice_controller_mutations_provider_creation
    ON voice_controller_mutations(provider_creation_id)
  `;
});
