import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A generation is local to a browser client session. Rebuild this FK chain
  // so closed sessions from different clients may both use generation 1 while
  // transport_session_id remains the durable identity. Renaming each parent
  // first lets SQLite keep every legacy FK valid until the replacement child
  // has been copied, avoiding disabled or deferred foreign-key enforcement.
  yield* sql`ALTER TABLE voice_transport_sessions RENAME TO voice_transport_sessions_legacy`;

  yield* sql`
    CREATE TABLE voice_transport_sessions (
      transport_session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      controller_thread_id TEXT NOT NULL,
      transport_thread_id TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      realtime_session_id TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('negotiating', 'active', 'closing', 'closed', 'failed', 'fenced')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO voice_transport_sessions
    SELECT * FROM voice_transport_sessions_legacy
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

  yield* sql`
    CREATE UNIQUE INDEX idx_voice_transport_sessions_one_open
    ON voice_transport_sessions(controller_thread_id)
    WHERE state IN ('negotiating', 'active', 'closing')
  `;
  yield* sql`
    CREATE INDEX idx_voice_transport_sessions_environment
    ON voice_transport_sessions(environment_id, generation DESC)
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
