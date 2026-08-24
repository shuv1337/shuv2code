import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { HealthTargetId, KernelEngine } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeHealthChecker,
  type AdeHealthCheckerOptions,
  AdeHealthProbes,
  type AdeHealthProbeResult,
  codexProbeResultFromStatus,
} from "./AdeHealthChecker.ts";

/**
 * Mutable probe fixture: tests flip a target's result between ticks the way
 * killing/restarting the real runtime would.
 */
const makeProbeControls = Effect.gen(function* () {
  const results = yield* Ref.make(
    new Map<HealthTargetId, AdeHealthProbeResult>([
      ["shuvcode", { state: "healthy" }],
      ["codex", { state: "healthy" }],
      ["screenbox", { state: "not-provisioned", detail: "Screenbox runtime is not provisioned." }],
    ]),
  );
  const set = (target: HealthTargetId, result: AdeHealthProbeResult) =>
    Ref.update(results, (map) => new Map(map).set(target, result));
  const probeFor = (target: HealthTargetId) =>
    Effect.map(
      Ref.get(results),
      (map) => map.get(target) ?? ({ state: "down", detail: "missing fixture" } as const),
    );
  const layer = Layer.succeed(
    AdeHealthProbes,
    AdeHealthProbes.of({
      probes: (["shuvcode", "codex", "screenbox"] as const).map((target) => ({
        target,
        probe: probeFor(target),
      })),
    }),
  );
  return { set, layer };
});

/** Builds the checker inside the test scope so its PubSub stays alive. */
const buildChecker = (
  probesLayer: Layer.Layer<AdeHealthProbes>,
  options?: AdeHealthCheckerOptions,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AdeHealthChecker.layerWith(options).pipe(Layer.provide(probesLayer)),
    );
    return yield* Effect.service(AdeHealthChecker).pipe(Effect.provide(context));
  });

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  return sql;
});

const seedBot = (sql: SqlClient.SqlClient, botId: string) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (${botId}, ${botId}, NULL, 'crew', 'Coder', NULL, NULL, 0, '2026-08-24T00:00:00.000Z', NULL)
  `;

const seedBinding = (
  sql: SqlClient.SqlClient,
  input: { bindingId: string; botId: string; engine: KernelEngine; status?: string },
) =>
  sql`
    INSERT INTO ade_bot_execution_bindings (
      binding_id, bot_id, engine, kernel_session_id, purpose, status, created_at, updated_at
    ) VALUES (
      ${input.bindingId}, ${input.botId}, ${input.engine}, ${`session-${input.bindingId}`},
      'primary-text', ${input.status ?? "active"},
      '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
    )
  `;

const seedAssignment = (
  sql: SqlClient.SqlClient,
  input: { assignmentId: string; botId: string; status: string; blockedReason?: string | null },
) =>
  sql`
    INSERT INTO ade_assignments (
      assignment_id, idempotency_key, requester_kind, requester_bot_id, recipient_bot_id,
      project_id, instruction, declared_risk, parent_assignment_id, status, blocked_reason,
      queue_position, result_json, delivered, delivered_at, created_at, updated_at
    ) VALUES (
      ${input.assignmentId}, ${input.assignmentId}, 'captain', NULL, ${input.botId},
      NULL, 'do the work', 'normal', NULL, ${input.status}, ${input.blockedReason ?? null},
      0, NULL, 0, NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
    )
  `;

const openKernelDownItems = (sql: SqlClient.SqlClient, engine: KernelEngine) =>
  Effect.map(
    sql<{ needs_you_item_id: string; subject_refs_json: string; status: string }>`
      SELECT needs_you_item_id, subject_refs_json, status FROM ade_needs_you_items
      WHERE kind = 'kernel-down'
    `,
    (rows) => rows.filter((row) => row.subject_refs_json.includes(`"engine":"${engine}"`)),
  );

const assignmentRow = (sql: SqlClient.SqlClient, assignmentId: string) =>
  Effect.map(
    sql<{ status: string; blocked_reason: string | null }>`
      SELECT status, blocked_reason FROM ade_assignments WHERE assignment_id = ${assignmentId}
    `,
    (rows) => rows[0]!,
  );

const targetState = (
  snapshot: { targets: ReadonlyArray<{ target: string; state: string }> },
  target: HealthTargetId,
) => snapshot.targets.find((entry) => entry.target === target)?.state;

/** Each case gets its own in-memory database: outages are per-test worlds. */
const testCase = (
  name: string,
  body: Effect.Effect<void, unknown, SqlClient.SqlClient | Scope.Scope>,
) =>
  it.effect(name, () =>
    Effect.scoped(body).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.orDie),
  );

describe("AdeHealthChecker", () => {
  testCase(
    "reports unknown before the first probe, then probe results",
    Effect.gen(function* () {
      yield* setup;
      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      const before = yield* checker.latest;
      assert.deepEqual(
        before.targets.map((entry) => entry.state),
        ["unknown", "unknown", "unknown"],
      );
      assert.deepEqual(
        before.targets.map((entry) => entry.target),
        ["shuvcode", "codex", "screenbox"],
      );

      const after = yield* checker.checkNow;
      assert.equal(targetState(after, "shuvcode"), "healthy");
      assert.equal(targetState(after, "codex"), "healthy");
      assert.equal(targetState(after, "screenbox"), "not-provisioned");
    }),
  );

  testCase(
    "kernel down: pill flips, one Needs You per outage, running blocks, queued stays queued",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-shuv");
      yield* seedBinding(sql, { bindingId: "b1", botId: "bot-shuv", engine: "shuvcode" });
      yield* seedAssignment(sql, {
        assignmentId: "a-running",
        botId: "bot-shuv",
        status: "running",
      });
      yield* seedAssignment(sql, { assignmentId: "a-queued", botId: "bot-shuv", status: "queued" });

      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      yield* checker.checkNow;
      yield* controls.set("shuvcode", { state: "down", detail: "connection refused" });
      const snapshot = yield* checker.checkNow;
      assert.equal(targetState(snapshot, "shuvcode"), "down");

      const items = yield* openKernelDownItems(sql, "shuvcode");
      assert.lengthOf(items, 1);
      assert.equal(items[0]!.status, "open");

      const running = yield* assignmentRow(sql, "a-running");
      assert.equal(running.status, "blocked");
      assert.equal(running.blocked_reason, "kernel-down");
      const queued = yield* assignmentRow(sql, "a-queued");
      assert.equal(queued.status, "queued");
      assert.isNull(queued.blocked_reason);

      // Further down ticks never duplicate the alert.
      yield* checker.checkNow;
      yield* checker.checkNow;
      assert.lengthOf(yield* openKernelDownItems(sql, "shuvcode"), 1);
    }),
  );

  testCase(
    "restart mid-outage: an existing open item suppresses a duplicate",
    Effect.gen(function* () {
      const sql = yield* setup;
      // A previous server process already alerted for this outage.
      yield* sql`
        INSERT INTO ade_needs_you_items (
          needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
        ) VALUES (
          'pre-existing', 'kernel-down', '[{"_tag":"kernel","engine":"codex"}]', 'open',
          '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL
        )
      `;

      const controls = yield* makeProbeControls;
      yield* controls.set("codex", { state: "down", detail: "still down" });
      const checker = yield* buildChecker(controls.layer);

      // First observation after restart is unknown -> down.
      yield* checker.checkNow;
      const items = yield* openKernelDownItems(sql, "codex");
      assert.lengthOf(items, 1);
      assert.equal(items[0]!.needs_you_item_id, "pre-existing");
    }),
  );

  testCase(
    "recovery: item resolves, blocked assignments release, next outage re-alerts",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-shuv");
      yield* seedBinding(sql, { bindingId: "b1", botId: "bot-shuv", engine: "shuvcode" });
      yield* seedAssignment(sql, { assignmentId: "a1", botId: "bot-shuv", status: "running" });

      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      yield* checker.checkNow;
      yield* controls.set("shuvcode", { state: "down", detail: "gone" });
      yield* checker.checkNow;
      assert.equal((yield* assignmentRow(sql, "a1")).status, "blocked");

      yield* controls.set("shuvcode", { state: "healthy" });
      const recovered = yield* checker.checkNow;
      assert.equal(targetState(recovered, "shuvcode"), "healthy");

      const items = yield* openKernelDownItems(sql, "shuvcode");
      assert.lengthOf(items, 1);
      assert.equal(items[0]!.status, "resolved");
      const released = yield* assignmentRow(sql, "a1");
      assert.equal(released.status, "running");
      assert.isNull(released.blocked_reason);

      // A second outage is a new alert (exactly once per outage, not ever).
      yield* controls.set("shuvcode", { state: "down", detail: "gone again" });
      yield* checker.checkNow;
      const afterSecondOutage = yield* openKernelDownItems(sql, "shuvcode");
      assert.lengthOf(afterSecondOutage, 2);
      assert.lengthOf(
        afterSecondOutage.filter((row) => row.status === "open"),
        1,
      );
    }),
  );

  testCase(
    "restart after outage ended: first healthy observation self-heals stale state",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-shuv");
      yield* seedBinding(sql, { bindingId: "b1", botId: "bot-shuv", engine: "shuvcode" });
      yield* seedAssignment(sql, {
        assignmentId: "a1",
        botId: "bot-shuv",
        status: "blocked",
        blockedReason: "kernel-down",
      });
      yield* sql`
        INSERT INTO ade_needs_you_items (
          needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
        ) VALUES (
          'stale', 'kernel-down', '[{"_tag":"kernel","engine":"shuvcode"}]', 'open',
          '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL
        )
      `;

      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      // unknown -> healthy runs the recovery path.
      yield* checker.checkNow;
      const items = yield* openKernelDownItems(sql, "shuvcode");
      assert.equal(items[0]!.status, "resolved");
      const released = yield* assignmentRow(sql, "a1");
      assert.equal(released.status, "running");
    }),
  );

  testCase(
    "release waits for every down engine the recipient bot is bound to",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-both");
      yield* seedBinding(sql, { bindingId: "b1", botId: "bot-both", engine: "shuvcode" });
      yield* seedBinding(sql, { bindingId: "b2", botId: "bot-both", engine: "codex" });
      yield* seedAssignment(sql, { assignmentId: "a1", botId: "bot-both", status: "running" });

      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      yield* checker.checkNow;
      yield* controls.set("shuvcode", { state: "down" });
      yield* controls.set("codex", { state: "down" });
      yield* checker.checkNow;
      assert.equal((yield* assignmentRow(sql, "a1")).status, "blocked");

      // Codex recovers but shuvcode is still down: stay blocked.
      yield* controls.set("codex", { state: "healthy" });
      yield* checker.checkNow;
      assert.equal((yield* assignmentRow(sql, "a1")).status, "blocked");

      yield* controls.set("shuvcode", { state: "healthy" });
      yield* checker.checkNow;
      assert.equal((yield* assignmentRow(sql, "a1")).status, "running");
    }),
  );

  testCase(
    "codex down leaves shuvcode-bound work untouched",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-shuv");
      yield* seedBinding(sql, { bindingId: "b1", botId: "bot-shuv", engine: "shuvcode" });
      yield* seedAssignment(sql, { assignmentId: "a1", botId: "bot-shuv", status: "running" });

      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      yield* checker.checkNow;
      yield* controls.set("codex", { state: "down" });
      yield* checker.checkNow;

      assert.equal((yield* assignmentRow(sql, "a1")).status, "running");
      assert.lengthOf(yield* openKernelDownItems(sql, "codex"), 1);
      assert.lengthOf(yield* openKernelDownItems(sql, "shuvcode"), 0);
    }),
  );

  testCase(
    "subscribe delivers the latest snapshot then pushes changes",
    Effect.gen(function* () {
      yield* setup;
      const controls = yield* makeProbeControls;
      const checker = yield* buildChecker(controls.layer);

      yield* checker.checkNow;
      const subscription = yield* checker.subscribe;
      assert.equal(targetState(subscription.latest, "shuvcode"), "healthy");

      yield* controls.set("shuvcode", { state: "down", detail: "boom" });
      yield* checker.checkNow;
      const pushed = yield* Stream.runHead(Stream.take(subscription.changes, 1));
      assert.isTrue(pushed._tag === "Some");
      if (pushed._tag === "Some") {
        assert.equal(targetState(pushed.value, "shuvcode"), "down");
      }
    }),
  );

  testCase(
    "a probe defect reads as down instead of killing the tick",
    Effect.gen(function* () {
      yield* setup;
      const layer = Layer.succeed(
        AdeHealthProbes,
        AdeHealthProbes.of({
          probes: [{ target: "codex", probe: Effect.die(new Error("boom")) }],
        }),
      );
      const checker = yield* buildChecker(layer);
      const snapshot = yield* checker.checkNow;
      assert.equal(targetState(snapshot, "codex"), "down");
    }),
  );

  testCase(
    "a hung probe times out to down and does not freeze reads or subscriptions",
    Effect.gen(function* () {
      yield* setup;
      const layer = Layer.succeed(
        AdeHealthProbes,
        AdeHealthProbes.of({
          probes: [
            { target: "shuvcode", probe: Effect.succeed({ state: "healthy" }) },
            { target: "codex", probe: Effect.never },
          ],
        }),
      );
      const checker = yield* buildChecker(layer, { probeTimeout: Duration.millis(50) });

      // While a tick with the hung probe is in flight, latest and subscribe
      // stay responsive (they must not share the tick mutex).
      const tick = yield* checker.checkNow.pipe(Effect.forkChild);
      const during = yield* checker.latest;
      assert.equal(targetState(during, "codex"), "unknown");
      const subscription = yield* checker.subscribe;
      assert.equal(targetState(subscription.latest, "codex"), "unknown");

      yield* TestClock.adjust(Duration.millis(60));
      const snapshot = yield* Fiber.join(tick);
      assert.equal(targetState(snapshot, "codex"), "down");
      const detail = snapshot.targets.find((entry) => entry.target === "codex")?.detail;
      assert.equal(detail, "probe timed out");
      assert.equal(targetState(snapshot, "shuvcode"), "healthy");
    }),
  );

  testCase(
    "an oversized probe detail is truncated before it reaches the snapshot",
    Effect.gen(function* () {
      yield* setup;
      const layer = Layer.succeed(
        AdeHealthProbes,
        AdeHealthProbes.of({
          probes: [
            {
              target: "screenbox",
              probe: Effect.succeed({ state: "not-provisioned", detail: "x".repeat(10_000) }),
            },
          ],
        }),
      );
      const checker = yield* buildChecker(layer);
      const snapshot = yield* checker.checkNow;
      const detail = snapshot.targets.find((entry) => entry.target === "screenbox")?.detail;
      assert.equal(detail?.length, 512);
    }),
  );
});

it("codexProbeResultFromStatus maps supervisor state to a pill state", () => {
  // Default topology never runs a shared process, so the supervisor's books
  // are structurally empty — that is a configuration gap, not health.
  assert.deepEqual(
    codexProbeResultFromStatus({ topology: "per-session", runningProcesses: 0, crashed: [] }),
    {
      state: "not-provisioned",
      detail: "codexAppServerTopology=per-session; the ADE Codex kernel requires shared topology.",
    },
  );
  assert.deepEqual(
    codexProbeResultFromStatus({ topology: "shared", runningProcesses: 1, crashed: [] }),
    { state: "healthy" },
  );
  // Idle supervisor spawns on demand: healthy, not down.
  assert.deepEqual(
    codexProbeResultFromStatus({ topology: "shared", runningProcesses: 0, crashed: [] }),
    { state: "healthy" },
  );
  assert.deepEqual(
    codexProbeResultFromStatus({
      topology: "shared",
      runningProcesses: 0,
      crashed: [{ digest: "d", consecutiveFailures: 2, lastExitAtMs: 1 }],
    }),
    { state: "down", detail: "codex app-server exited (2 consecutive failures)" },
  );
  // A crashed identity that already respawned is not an outage.
  assert.deepEqual(
    codexProbeResultFromStatus({
      topology: "shared",
      runningProcesses: 1,
      crashed: [{ digest: "d", consecutiveFailures: 1, lastExitAtMs: 1 }],
    }),
    { state: "healthy" },
  );
});
