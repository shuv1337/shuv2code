import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type BotExecutionBindingId,
  type KernelSessionId,
  SESSION_ROLLOVER_SUMMARY_MAX_LENGTH,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeSessionRollover, renderSessionProjection } from "./AdeSessionRollover.ts";
import { FIRSTMATE_TEMPLATE } from "./personaTemplates.ts";

const makeLayer = () =>
  Layer.mergeAll(AdeBootstrap.layer, AdePersonaMemory.layer, AdeSessionRollover.layer).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

const sessionId = (value: string) => value as KernelSessionId;

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return {
    sql,
    bootstrap,
    personaMemory: yield* AdePersonaMemory,
    sessions: yield* AdeSessionRollover,
    botId: seeded.firstmateBotId,
  };
});

const insertAssignment = (input: {
  readonly id: string;
  readonly botId: string;
  readonly instruction: string;
  readonly status: string;
  readonly blockedReason?: string;
  readonly queuePosition: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO ade_assignments (
        assignment_id, idempotency_key, requester_kind, requester_bot_id,
        recipient_bot_id, project_id, instruction, declared_risk,
        parent_assignment_id, status, blocked_reason, queue_position,
        result_json, delivered, delivered_at, created_at, updated_at
      ) VALUES (
        ${input.id}, ${`key-${input.id}`}, 'captain', NULL,
        ${input.botId}, NULL, ${input.instruction}, 'normal',
        NULL, ${input.status}, ${input.blockedReason ?? null}, ${input.queuePosition},
        NULL, 0, NULL, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      )
    `;
  });

describe("AdeSessionRollover.startPrimarySession", () => {
  it.effect("projects persona + memory + active assignments at session creation", () =>
    Effect.gen(function* () {
      const { sql, sessions, personaMemory, botId } = yield* setup;

      yield* personaMemory.writeMemory({
        botId,
        content: "Captain prefers stacked PRs.",
        author: "bot",
      });
      yield* insertAssignment({
        id: "a-2",
        botId,
        instruction: "Review the publication stack",
        status: "running",
        queuePosition: 1,
      });
      yield* insertAssignment({
        id: "a-1",
        botId,
        instruction: "Ship the roster UI",
        status: "queued",
        queuePosition: 0,
      });
      yield* insertAssignment({
        id: "a-blocked",
        botId,
        instruction: "Wait for approval",
        status: "blocked",
        blockedReason: "approval",
        queuePosition: 2,
      });
      // Terminal assignments never ride into a session.
      yield* insertAssignment({
        id: "a-done",
        botId,
        instruction: "Old work",
        status: "completed",
        queuePosition: 3,
      });

      const started = yield* sessions.startPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-1"),
      });

      // Component 1 — persona (the bootstrap-shipped v1, already active).
      assert.equal(started.projection.persona, FIRSTMATE_TEMPLATE.personaContent);
      // Component 2 — memory.
      assert.equal(started.projection.memory, "Captain prefers stacked PRs.");
      // Component 3 — active assignments, FIFO order, terminal ones excluded.
      assert.deepEqual(
        started.projection.activeAssignments.map((a) => [a.assignmentId, a.status]),
        [
          ["a-1", "queued"],
          ["a-2", "running"],
          ["a-blocked", "blocked"],
        ],
      );
      assert.equal(started.projection.activeAssignments[2]!.blockedReason, "approval");
      // Component 4 — no outgoing session yet on a first start.
      assert.isNull(started.projection.outgoingSessionSummary);
      assert.isNull(started.supersededBindingId);

      // Binding row: active primary-text, engine + session recorded.
      const bindings = yield* sql<{
        bot_id: string;
        engine: string;
        kernel_session_id: string;
        purpose: string;
        status: string;
      }>`
        SELECT bot_id, engine, kernel_session_id, purpose, status
        FROM ade_bot_execution_bindings WHERE binding_id = ${started.binding.id}
      `;
      assert.deepEqual(bindings[0], {
        bot_id: botId,
        engine: "shuvcode",
        kernel_session_id: "sess-1",
        purpose: "primary-text",
        status: "active",
      });

      // The rendered projection carries all sections for the kernel prompt.
      const rendered = renderSessionProjection(started.projection);
      assert.include(rendered, FIRSTMATE_TEMPLATE.personaContent);
      assert.include(rendered, "## Your memory");
      assert.include(rendered, "Captain prefers stacked PRs.");
      assert.include(rendered, "Ship the roster UI");
      assert.notInclude(rendered, "Old work");
      assert.notInclude(rendered, "## Summary of your previous session");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("activates a pending persona edit at the next session, not live", () =>
    Effect.gen(function* () {
      const { sql, sessions, personaMemory, botId } = yield* setup;

      const first = yield* sessions.startPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-live"),
      });
      assert.equal(first.projection.persona, FIRSTMATE_TEMPLATE.personaContent);

      // Captain edits the persona while the session runs: nothing changes live.
      const edited = yield* personaMemory.editPersona({ botId, content: "You are terse." });

      // The *next* session (an explicit rollover) picks it up and activates it.
      const next = yield* sessions.rolloverPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-next"),
        outgoingSummary: "Wrapped up the roster work.",
      });
      assert.equal(next.projection.persona, "You are terse.");
      assert.equal(next.projection.personaVersionId, edited.id);
      assert.equal(next.supersededBindingId, first.binding.id);

      const version = yield* sql<{ activated_at: string | null }>`
        SELECT activated_at FROM ade_persona_versions WHERE persona_version_id = ${edited.id}
      `;
      assert.isNotNull(version[0]!.activated_at);
      const bot = yield* sql<{ active_persona_version_id: string | null }>`
        SELECT active_persona_version_id FROM ade_bots WHERE bot_id = ${botId}
      `;
      assert.equal(bot[0]!.active_persona_version_id, edited.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a second primary session while one is active — concurrent-safe", () =>
    Effect.gen(function* () {
      const { sql, sessions, botId } = yield* setup;

      // Two concurrent first starts: exactly one wins, the loser is refused
      // with the surviving binding named.
      const [a, b] = yield* Effect.all(
        [
          Effect.exit(
            sessions.startPrimarySession({
              botId,
              engine: "shuvcode",
              sessionId: sessionId("race-a"),
            }),
          ),
          Effect.exit(
            sessions.startPrimarySession({
              botId,
              engine: "shuvcode",
              sessionId: sessionId("race-b"),
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [a, b];
      const winners = outcomes.filter(Exit.isSuccess);
      const losers = outcomes.filter(Exit.isFailure);
      assert.lengthOf(winners, 1);
      assert.lengthOf(losers, 1);

      const active = yield* sql<{ binding_id: string; kernel_session_id: string }>`
        SELECT binding_id, kernel_session_id FROM ade_bot_execution_bindings
        WHERE bot_id = ${botId} AND purpose = 'primary-text' AND status = 'active'
      `;
      assert.lengthOf(active, 1);

      // A later explicit attempt is refused the same way.
      const refusal = yield* Effect.flip(
        sessions.startPrimarySession({
          botId,
          engine: "codex",
          sessionId: sessionId("late"),
        }),
      );
      assert.equal(refusal._tag, "AdePrimarySessionActiveError");
      if (refusal._tag !== "AdePrimarySessionActiveError") {
        return assert.fail("expected AdePrimarySessionActiveError");
      }
      assert.equal(refusal.existingBindingId, active[0]!.binding_id);
      assert.equal(refusal.existingSessionId, active[0]!.kernel_session_id);

      // And the invariant holds at the schema level: even raw SQL cannot
      // create a second active primary row (race-proof under concurrency).
      const rawInsert = yield* Effect.exit(sql`
        INSERT INTO ade_bot_execution_bindings (
          binding_id, bot_id, engine, kernel_session_id, purpose, status,
          rollover_summary, created_at, updated_at
        ) VALUES (
          'raw', ${botId}, 'codex', 'raw-sess', 'primary-text', 'active',
          NULL, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
        )
      `);
      assert.isTrue(Exit.isFailure(rawInsert));
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeSessionRollover.rolloverPrimarySession", () => {
  it.effect("composes all four components and retires the outgoing binding", () =>
    Effect.gen(function* () {
      const { sql, sessions, personaMemory, botId } = yield* setup;

      yield* personaMemory.writeMemory({ botId, content: "Fleet has one project.", author: "bot" });
      yield* insertAssignment({
        id: "carry-1",
        botId,
        instruction: "Carry me across the rollover",
        status: "queued",
        queuePosition: 0,
      });

      const first = yield* sessions.startPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-old"),
      });

      const rolled = yield* sessions.rolloverPrimarySession({
        botId,
        engine: "codex", // engine change is a locked rollover trigger (ADR §12.3)
        sessionId: sessionId("sess-new"),
        outgoingSummary: "Ran out of context while reviewing.",
      });

      // All four components (ADR §12.3).
      assert.equal(rolled.projection.persona, FIRSTMATE_TEMPLATE.personaContent);
      assert.equal(rolled.projection.memory, "Fleet has one project.");
      assert.deepEqual(
        rolled.projection.activeAssignments.map((a) => a.assignmentId),
        ["carry-1"],
      );
      assert.equal(rolled.projection.outgoingSessionSummary, "Ran out of context while reviewing.");
      assert.include(
        renderSessionProjection(rolled.projection),
        "## Summary of your previous session",
      );

      // Old binding is history (never deleted), summary recorded on it.
      assert.equal(rolled.supersededBindingId, first.binding.id);
      const rows = yield* sql<{
        binding_id: string;
        status: string;
        rollover_summary: string | null;
      }>`
        SELECT binding_id, status, rollover_summary FROM ade_bot_execution_bindings
        WHERE bot_id = ${botId} AND purpose = 'primary-text'
        ORDER BY created_at ASC, rowid ASC
      `;
      assert.lengthOf(rows, 2);
      assert.deepEqual(rows[0], {
        binding_id: first.binding.id,
        status: "historical",
        rollover_summary: "Ran out of context while reviewing.",
      });
      assert.deepEqual(rows[1], {
        binding_id: rolled.binding.id,
        status: "active",
        rollover_summary: null,
      });
      assert.equal(rolled.binding.engine, "codex");
      assert.equal(rolled.binding.sessionId, "sess-new");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("enforces the 16 KB summary bound and tolerates a lost outgoing binding", () =>
    Effect.gen(function* () {
      const { sessions, botId } = yield* setup;

      const overBound = yield* Effect.flip(
        sessions.rolloverPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: sessionId("sess-x"),
          outgoingSummary: "s".repeat(SESSION_ROLLOVER_SUMMARY_MAX_LENGTH + 1),
        }),
      );
      assert.equal(overBound._tag, "AdeRolloverSummaryLimitExceededError");
      assert.include(overBound.message, "16384");

      // Crash recovery: no active binding to supersede — rollover still
      // starts the replacement with what it has.
      const recovered = yield* sessions.rolloverPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-recovered"),
        outgoingSummary: "s".repeat(SESSION_ROLLOVER_SUMMARY_MAX_LENGTH),
      });
      assert.isNull(recovered.supersededBindingId);
      assert.equal(recovered.binding.status, "active");
      assert.equal(
        recovered.projection.outgoingSessionSummary?.length,
        SESSION_ROLLOVER_SUMMARY_MAX_LENGTH,
      );
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeSessionRollover binding maintenance", () => {
  it.effect("opens and closes non-primary bindings through the session lifecycle", () =>
    Effect.gen(function* () {
      const { sessions, botId } = yield* setup;

      const primary = yield* sessions.startPrimarySession({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-primary"),
      });
      const voice = yield* sessions.openBinding({
        botId,
        engine: "codex",
        sessionId: sessionId("sess-voice"),
        purpose: "voice",
      });
      // Non-primary bindings do not trip the one-active-primary invariant.
      const parallel = yield* sessions.openBinding({
        botId,
        engine: "shuvcode",
        sessionId: sessionId("sess-parallel"),
        purpose: "parallel-work",
      });

      yield* sessions.closeBinding({
        bindingId: voice.id,
        status: "historical",
        summary: "Discussed the roster over voice.",
      });
      yield* sessions.closeBinding({ bindingId: parallel.id, status: "lost" });

      const bindings = yield* sessions.listBindings(botId);
      const byId = new Map(bindings.map((binding) => [binding.id, binding]));
      assert.equal(byId.get(primary.binding.id)?.status, "active");
      assert.equal(byId.get(voice.id)?.status, "historical");
      assert.equal(byId.get(parallel.id)?.status, "lost");
      assert.lengthOf(bindings, 3);

      const missing = yield* Effect.flip(
        sessions.closeBinding({ bindingId: "nope" as BotExecutionBindingId, status: "lost" }),
      );
      assert.equal(missing._tag, "AdeBindingNotFoundError");
    }).pipe(Effect.provide(makeLayer())),
  );
});
