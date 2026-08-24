import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import type { AssignmentId, BotId, KernelEngine } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeAssignmentEngine,
  AdeAssignmentKernelPort,
  AdeAssignmentKernelPortError,
  type AdeAssignmentDeliveryBatch,
  type AdeAssignmentEngineShape,
} from "./AdeAssignmentEngine.ts";

const AT = "2026-08-24T00:00:00.000Z";

const seedBot = (sql: SqlClient.SqlClient, botId: string, projectId: string | null = null) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (${botId}, ${botId}, NULL, 'crew', 'Coder', ${projectId}, NULL, 0, ${AT}, NULL)
  `;

const seedBinding = (
  sql: SqlClient.SqlClient,
  input: { botId: string; engine?: KernelEngine; sessionId?: string },
) =>
  sql`
    INSERT INTO ade_bot_execution_bindings (
      binding_id, bot_id, engine, kernel_session_id, purpose, status,
      rollover_summary, created_at, updated_at
    ) VALUES (
      ${`binding-${input.botId}`}, ${input.botId}, ${input.engine ?? "shuvcode"},
      ${input.sessionId ?? `session-${input.botId}`}, 'primary-text', 'active',
      NULL, ${AT}, ${AT}
    )
  `;

/** Push an assignment's `updated_at` back into the past (stall fixtures). */
const backdate = (sql: SqlClient.SqlClient, assignmentId: string, by: Duration.Duration) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(DateTime.subtractDuration(now, by));
    yield* sql`
      UPDATE ade_assignments SET updated_at = ${at} WHERE assignment_id = ${assignmentId}
    `;
  });

/** Controllable kernel port: records batches, and can stall or refuse them. */
const makePortFixture = Effect.gen(function* () {
  const sends = yield* Ref.make<Array<AdeAssignmentDeliveryBatch>>([]);
  const healthy = yield* Ref.make(true);
  const refuse = yield* Ref.make(false);
  const liveSessions = yield* Ref.make(new Set<string>());
  /**
   * Set to make `deliverResults` signal `started` and then block on
   * `release` — the crash window between the kernel call and the durable
   * `delivered` mark.
   */
  const stall = yield* Ref.make<{
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null>(null);

  const layer = Layer.succeed(AdeAssignmentKernelPort, {
    kernelHealth: () =>
      Effect.map(Ref.get(healthy), (available) =>
        available ? { available } : { available, detail: "test outage" },
      ),
    deliverResults: (batch: AdeAssignmentDeliveryBatch) =>
      Effect.gen(function* () {
        if (yield* Ref.get(refuse)) {
          return yield* new AdeAssignmentKernelPortError({
            operation: "deliverResults",
            detail: "refused by fixture",
          });
        }
        yield* Ref.update(sends, (all) => [...all, batch]);
        const gate = yield* Ref.get(stall);
        if (gate !== null) {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
      }),
    steerPrimary: () => Effect.void,
    isSessionLive: (input: { engine: KernelEngine; sessionId: string }) =>
      Effect.map(Ref.get(liveSessions), (live) => live.has(input.sessionId)),
  });

  return { layer, sends, healthy, refuse, liveSessions, stall };
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const port = yield* makePortFixture;
  const context = yield* Layer.build(AdeAssignmentEngine.layer.pipe(Layer.provide(port.layer)));
  const engine = yield* Effect.service(AdeAssignmentEngine).pipe(Effect.provide(context));
  return { sql, engine, port };
});

/**
 * One fresh in-memory database per test: the engine's invariants are about
 * durable rows, so tests must not share a schema or a bot roster.
 */
const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

const create = (
  engine: AdeAssignmentEngineShape,
  input: {
    requesterBotId?: string;
    recipientBotId: string;
    instruction?: string;
    idempotencyKey: string;
    parentAssignmentId?: string;
  },
) =>
  engine.createAssignment({
    requester:
      input.requesterBotId === undefined
        ? { _tag: "captain" }
        : { _tag: "bot", botId: input.requesterBotId as BotId },
    recipientBotId: input.recipientBotId as BotId,
    instruction: input.instruction ?? "do the work",
    idempotencyKey: input.idempotencyKey,
    parentAssignmentId: (input.parentAssignmentId ?? null) as AssignmentId | null,
  });

describe("AdeAssignmentEngine", () => {
  describe("idempotent creation (ADR §13.6)", () => {
    scenario("the same requester + key yields one assignment", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");

        const first = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "key-1",
        });
        const replay = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          instruction: "different text, same key",
          idempotencyKey: "key-1",
        });

        assert.isTrue(first.created);
        assert.isFalse(replay.created);
        assert.equal(replay.assignment.id, first.assignment.id);
        assert.equal(replay.assignment.instruction, "do the work");

        const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ade_assignments
        `;
        assert.equal(rows[0]?.count, 1);
      }),
    );

    scenario("keys are scoped per requester; the captain's NULL folds to one bucket", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "other");
        yield* seedBot(sql, "coder");

        yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "shared",
        });
        const otherBot = yield* create(engine, {
          requesterBotId: "other",
          recipientBotId: "coder",
          idempotencyKey: "shared",
        });
        assert.isTrue(otherBot.created);

        const captain = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "shared",
        });
        assert.isTrue(captain.created);
        const captainReplay = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "shared",
        });
        assert.isFalse(captainReplay.created);
        assert.equal(captainReplay.assignment.id, captain.assignment.id);

        const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ade_assignments`;
        assert.equal(rows[0]?.count, 3);
      }),
    );

    scenario("refuses archived recipients and over-deep lineage", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        // Everything unspecified decodes to the ADR §18.1 defaults.
        yield* sql`
          INSERT INTO ade_limits_config (id, config_json, updated_at)
          VALUES (1, ${JSON.stringify({ maxDelegationDepth: 2 })}, ${AT})
        `;

        const root = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "root",
        });
        const child = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "child",
          parentAssignmentId: root.assignment.id,
        });
        const tooDeep = yield* Effect.flip(
          create(engine, {
            requesterBotId: "boss",
            recipientBotId: "coder",
            idempotencyKey: "grandchild",
            parentAssignmentId: child.assignment.id,
          }),
        );
        assert.equal(tooDeep._tag, "AdeAssignmentLimitExceededError");

        yield* sql`UPDATE ade_bots SET archived_at = ${AT} WHERE bot_id = 'coder'`;
        const archived = yield* Effect.flip(
          create(engine, {
            requesterBotId: "boss",
            recipientBotId: "coder",
            idempotencyKey: "after-archive",
          }),
        );
        assert.equal(archived._tag, "AdeBotArchivedError");
      }),
    );
  });

  describe("per-bot FIFO with explicit reorder (§13.2)", () => {
    scenario("creation is FIFO and reorder permutes the queued positions", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "coder");

        const a = yield* create(engine, { recipientBotId: "coder", idempotencyKey: "a" });
        const b = yield* create(engine, { recipientBotId: "coder", idempotencyKey: "b" });
        const c = yield* create(engine, { recipientBotId: "coder", idempotencyKey: "c" });
        assert.deepEqual(
          [a.assignment.queuePosition, b.assignment.queuePosition, c.assignment.queuePosition],
          [0, 1, 2],
        );
        const head = yield* engine.nextQueued("coder" as BotId);
        assert.equal(head?.id, a.assignment.id);

        const reordered = yield* engine.reorderQueue("coder" as BotId, [
          c.assignment.id,
          a.assignment.id,
          b.assignment.id,
        ]);
        assert.deepEqual(
          reordered.map((assignment) => assignment.id),
          [c.assignment.id, a.assignment.id, b.assignment.id],
        );
        const newHead = yield* engine.nextQueued("coder" as BotId);
        assert.equal(newHead?.id, c.assignment.id);

        const mismatch = yield* Effect.flip(
          engine.reorderQueue("coder" as BotId, [c.assignment.id]),
        );
        assert.equal(mismatch._tag, "AdeQueueReorderMismatchError");
      }),
    );
  });

  describe("kernel-down admission (ADR §11.3)", () => {
    scenario("start parks the assignment as blocked kernel-down during an outage", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "coder" });
        const assignment = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "work",
        });

        yield* Ref.set(port.healthy, false);
        const blocked = yield* engine.startAssignment(assignment.assignment.id);
        assert.isTrue(blocked.blockedByKernel);
        assert.equal(blocked.assignment.status, "blocked");
        assert.equal(blocked.assignment.blockedReason, "kernel-down");

        yield* Ref.set(port.healthy, true);
        const running = yield* engine.startAssignment(assignment.assignment.id);
        assert.isFalse(running.blockedByKernel);
        assert.equal(running.assignment.status, "running");
        assert.isNull(running.assignment.blockedReason);
      }),
    );
  });

  describe("cascade cancel scope (§13.4)", () => {
    scenario("cancels descendants only — never ancestors or siblings", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "coder");

        const grandparent = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "gp",
        });
        const parent = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "p",
          parentAssignmentId: grandparent.assignment.id,
        });
        const sibling = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "sib",
          parentAssignmentId: grandparent.assignment.id,
        });
        const child = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "c",
          parentAssignmentId: parent.assignment.id,
        });
        const grandchild = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "gc",
          parentAssignmentId: child.assignment.id,
        });

        const cancelled = yield* engine.cancelAssignment({
          assignmentId: parent.assignment.id,
          cascade: true,
        });
        assert.deepEqual(
          new Set(cancelled.cancelled),
          new Set([parent.assignment.id, child.assignment.id, grandchild.assignment.id]),
        );

        const statusOf = (assignmentId: AssignmentId) =>
          Effect.map(engine.getAssignment(assignmentId), (assignment) => assignment?.status);
        assert.equal(yield* statusOf(grandparent.assignment.id), "queued");
        assert.equal(yield* statusOf(sibling.assignment.id), "queued");
        assert.equal(yield* statusOf(child.assignment.id), "cancelled");
        assert.equal(yield* statusOf(grandchild.assignment.id), "cancelled");
      }),
    );

    scenario("without cascade only the named assignment is cancelled", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "coder");
        const parent = yield* create(engine, { recipientBotId: "coder", idempotencyKey: "p" });
        const child = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "c",
          parentAssignmentId: parent.assignment.id,
        });

        const cancelled = yield* engine.cancelAssignment({
          assignmentId: parent.assignment.id,
          cascade: false,
        });
        assert.deepEqual(cancelled.cancelled, [parent.assignment.id]);
        const stillOpen = yield* engine.getAssignment(child.assignment.id);
        assert.equal(stillOpen?.status, "queued");

        const again = yield* Effect.flip(
          engine.cancelAssignment({ assignmentId: parent.assignment.id, cascade: false }),
        );
        assert.equal(again._tag, "AdeAssignmentTerminalError");
      }),
    );
  });

  describe("exactly-once delivery (§13.6)", () => {
    scenario("one batch per drain; a delivered batch is never re-sent", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "boss" });

        const one = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "one",
        });
        const two = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "two",
        });
        yield* engine.reportResult({
          assignmentId: one.assignment.id,
          status: "completed",
          summary: "first done",
        });
        yield* engine.reportResult({
          assignmentId: two.assignment.id,
          status: "failed",
          summary: "second failed",
        });

        const drain = yield* engine.deliverPending();
        assert.lengthOf(drain.delivered, 1);
        assert.lengthOf(drain.delivered[0]!.items, 2);
        assert.include(drain.delivered[0]!.text, "first done");
        assert.isFalse(drain.delivered[0]!.redelivery);

        const again = yield* engine.deliverPending();
        assert.lengthOf(again.delivered, 0);
        const sends = yield* Ref.get(port.sends);
        assert.lengthOf(sends, 1);

        const rows = yield* sql<{ delivered: number; delivery_state: string }>`
          SELECT delivered, delivery_state FROM ade_assignments
        `;
        assert.isTrue(
          rows.every((row) => row.delivered === 1 && row.delivery_state === "delivered"),
        );
      }),
    );

    scenario("a replayed report never queues a second delivery", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "boss" });
        const assignment = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "one",
        });

        const first = yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "done",
        });
        const replay = yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "failed",
          summary: "overwrite attempt",
        });
        assert.isTrue(first.recorded);
        assert.isFalse(replay.recorded);
        assert.equal(replay.assignment.result?.summary, "done");

        yield* engine.deliverPending();
        yield* engine.deliverPending();
        assert.lengthOf(yield* Ref.get(port.sends), 1);
      }),
    );

    scenario("a crash inside the send window redelivers once, under the same delivery key", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "boss" });
        const assignment = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "one",
        });
        yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "done",
        });

        // Simulate the crash: the claim is committed, the kernel call is in
        // flight, and the process dies before the delivered mark.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(port.stall, { started, release });
        const fiber = yield* Effect.forkChild(engine.deliverPending());
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Ref.set(port.stall, null);

        const midFlight = yield* sql<{
          delivery_state: string;
          delivery_attempt_id: string | null;
        }>`
          SELECT delivery_state, delivery_attempt_id FROM ade_assignments
        `;
        assert.equal(midFlight[0]?.delivery_state, "delivering");
        const claimedKey = midFlight[0]?.delivery_attempt_id;
        assert.isNotNull(claimedKey);

        // A plain drain must not pick a claimed batch back up.
        yield* engine.deliverPending();
        assert.lengthOf(yield* Ref.get(port.sends), 1);

        // Recovery re-drives it with the SAME durable key, flagged as a
        // redelivery, so the kernel side dedupes: exactly one delivery.
        const recovered = yield* engine.recoverInterruptedDeliveries();
        assert.lengthOf(recovered.delivered, 1);
        assert.equal(recovered.delivered[0]!.deliveryKey, claimedKey);
        assert.isTrue(recovered.delivered[0]!.redelivery);

        const sends = yield* Ref.get(port.sends);
        assert.lengthOf(sends, 2);
        assert.equal(new Set(sends.map((batch) => batch.deliveryKey)).size, 1);

        const finished = yield* sql<{ delivered: number; delivery_state: string }>`
          SELECT delivered, delivery_state FROM ade_assignments
        `;
        assert.equal(finished[0]?.delivered, 1);
        assert.equal(finished[0]?.delivery_state, "delivered");

        // Everything settled: no further sends, ever.
        yield* engine.deliverPending();
        yield* engine.recoverInterruptedDeliveries();
        assert.lengthOf(yield* Ref.get(port.sends), 2);
      }),
    );

    scenario("a refused delivery returns to pending and retries later", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "boss" });
        const assignment = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "one",
        });
        yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "done",
        });

        yield* Ref.set(port.refuse, true);
        const failed = yield* engine.deliverPending();
        assert.lengthOf(failed.failed, 1);
        const pending = yield* sql<{ delivery_state: string }>`
          SELECT delivery_state FROM ade_assignments
        `;
        assert.equal(pending[0]?.delivery_state, "pending");

        yield* Ref.set(port.refuse, false);
        const delivered = yield* engine.deliverPending();
        assert.lengthOf(delivered.delivered, 1);
        assert.lengthOf(yield* Ref.get(port.sends), 1);
      }),
    );

    scenario("captain-requested results are not injected as synthetic input", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "coder");
        const assignment = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "one",
        });
        yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "done",
        });
        const drain = yield* engine.deliverPending();
        assert.lengthOf(drain.delivered, 0);
        assert.lengthOf(yield* Ref.get(port.sends), 0);
        const rows = yield* sql<{ delivery_state: string }>`
          SELECT delivery_state FROM ade_assignments
        `;
        assert.equal(rows[0]?.delivery_state, "not-applicable");
      }),
    );

    scenario("results wait for a primary session before they are claimed", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        const assignment = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "one",
        });
        yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "done",
        });

        const deferred = yield* engine.deliverPending();
        assert.deepEqual(deferred.deferredBotIds, ["boss" as BotId]);
        assert.lengthOf(yield* Ref.get(port.sends), 0);

        yield* seedBinding(sql, { botId: "boss" });
        const delivered = yield* engine.deliverPending();
        assert.lengthOf(delivered.delivered, 1);
      }),
    );
  });

  describe("parental waits and batched child notifications (§13.5)", () => {
    scenario("children are held until the last one settles, then land as one batch", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        yield* seedBinding(sql, { botId: "boss" });

        const parent = yield* create(engine, {
          recipientBotId: "boss",
          idempotencyKey: "parent",
        });
        const childA = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "child-a",
          parentAssignmentId: parent.assignment.id,
        });
        const childB = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "child-b",
          parentAssignmentId: parent.assignment.id,
        });

        const wait = yield* engine.waitForChildren(parent.assignment.id);
        assert.isTrue(wait.waiting);
        assert.equal(wait.parent.blockedReason, "children");
        assert.lengthOf(wait.outstandingChildren, 2);

        yield* engine.reportResult({
          assignmentId: childA.assignment.id,
          status: "completed",
          summary: "a done",
        });
        const held = yield* engine.deliverPending();
        assert.lengthOf(held.delivered, 0);
        assert.lengthOf(yield* Ref.get(port.sends), 0);

        yield* engine.reportResult({
          assignmentId: childB.assignment.id,
          status: "completed",
          summary: "b done",
        });
        const batched = yield* engine.deliverPending();
        assert.lengthOf(batched.delivered, 1);
        assert.lengthOf(batched.delivered[0]!.items, 2);
        assert.equal(batched.delivered[0]!.parentAssignmentId, parent.assignment.id);

        const released = yield* engine.getAssignment(parent.assignment.id);
        assert.equal(released?.status, "running");
        assert.isNull(released?.blockedReason);

        const bindings = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ade_bot_execution_bindings
        `;
        assert.equal(bindings[0]?.count, 1);
      }),
    );

    scenario("waiting on already-settled children does not block the parent", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "boss");
        yield* seedBot(sql, "coder");
        const parent = yield* create(engine, {
          recipientBotId: "boss",
          idempotencyKey: "parent",
        });
        const child = yield* create(engine, {
          requesterBotId: "boss",
          recipientBotId: "coder",
          idempotencyKey: "child",
          parentAssignmentId: parent.assignment.id,
        });
        yield* engine.reportResult({
          assignmentId: child.assignment.id,
          status: "completed",
          summary: "done",
        });

        const wait = yield* engine.waitForChildren(parent.assignment.id);
        assert.isFalse(wait.waiting);
        assert.equal(wait.parent.status, "queued");
      }),
    );
  });

  describe("restart recovery (spec §4.2, ADR §16)", () => {
    scenario("live sessions are re-adopted; everything else needs resume", () =>
      Effect.gen(function* () {
        const { sql, engine, port } = yield* setup;
        yield* seedBot(sql, "live");
        yield* seedBot(sql, "gone");
        yield* seedBot(sql, "unbound");
        yield* seedBinding(sql, { botId: "live", sessionId: "session-live" });
        yield* seedBinding(sql, { botId: "gone", sessionId: "session-gone" });
        yield* Ref.set(port.liveSessions, new Set(["session-live"]));

        const ids: Array<AssignmentId> = [];
        for (const botId of ["live", "gone", "unbound"]) {
          const assignment = yield* create(engine, {
            recipientBotId: botId,
            idempotencyKey: `work-${botId}`,
          });
          yield* engine.startAssignment(assignment.assignment.id);
          ids.push(assignment.assignment.id);
        }

        const recovered = yield* engine.recoverRunningAssignments();
        assert.deepEqual(recovered.adopted, [ids[0]!]);
        assert.deepEqual(new Set(recovered.needsResume), new Set([ids[1], ids[2]]));

        const blocked = yield* engine.getAssignment(ids[1]!);
        assert.equal(blocked?.status, "blocked");
        assert.equal(blocked?.blockedReason, "needs-resume");
      }),
    );
  });

  describe("stall surfacing (§13.3 — no auto-retry, no auto-timeout)", () => {
    scenario("one open Needs You item per silent running assignment", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "coder");
        const assignment = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "work",
        });
        yield* engine.startAssignment(assignment.assignment.id);
        // Backdate past the stall window (the test clock starts at the epoch,
        // so the timestamp has to be derived, not hard-coded).
        yield* backdate(sql, assignment.assignment.id, Duration.hours(1));

        const surfaced = yield* engine.surfaceStalls({ stallAfter: Duration.minutes(15) });
        assert.deepEqual(surfaced, [assignment.assignment.id]);
        const dedupe = yield* engine.surfaceStalls({ stallAfter: Duration.minutes(15) });
        assert.lengthOf(dedupe, 0);

        const items = yield* sql<{ status: string }>`
          SELECT status FROM ade_needs_you_items WHERE kind = 'stall'
        `;
        assert.lengthOf(items, 1);

        // Progress (or a result) closes the item.
        yield* engine.reportResult({
          assignmentId: assignment.assignment.id,
          status: "completed",
          summary: "finally",
        });
        const resolved = yield* sql<{ status: string }>`
          SELECT status FROM ade_needs_you_items WHERE kind = 'stall'
        `;
        assert.equal(resolved[0]?.status, "resolved");
      }),
    );

    scenario("noteProgress resets the stall clock", () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* setup;
        yield* seedBot(sql, "coder");
        const assignment = yield* create(engine, {
          recipientBotId: "coder",
          idempotencyKey: "work",
        });
        yield* engine.startAssignment(assignment.assignment.id);
        // Backdate past the stall window (the test clock starts at the epoch,
        // so the timestamp has to be derived, not hard-coded).
        yield* backdate(sql, assignment.assignment.id, Duration.hours(1));
        yield* engine.noteProgress(assignment.assignment.id);
        const surfaced = yield* engine.surfaceStalls({ stallAfter: Duration.minutes(15) });
        assert.lengthOf(surfaced, 0);
      }),
    );
  });
});
