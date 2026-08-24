import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { FetchHttpClient } from "effect/unstable/http";

import type { BotId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeScreenboxRuntime,
  AdeScreenboxToolPlaneLive,
  SCREENBOX_OPERATE_TOOLS,
  type AdeScreenboxRuntimeShape,
} from "./AdeScreenbox.ts";
import {
  AdeScreenboxClient,
  AdeScreenboxConfig,
  parseMcpResponseBody,
} from "./AdeScreenboxClient.ts";
import {
  AdeScreenboxToolPlane,
  type AdeScreenboxToolPlaneShape,
  type AdeToolCallContext,
  adeToolHandlersUnavailable,
  makeAdeToolGate,
} from "./AdeToolGate.ts";
import {
  startAdeScreenboxMock,
  type AdeScreenboxMock,
  type AdeScreenboxMockOptions,
} from "./adeScreenboxMock.testSupport.ts";

/** Past the default `LimitsConfig.screenboxIdleStopMinutes` (30). */
const PAST_IDLE_WINDOW = Duration.minutes(31);

const seedBot = (
  sql: SqlClient.SqlClient,
  botId: string,
  options: { readonly computerUse?: boolean; readonly name?: string } = {},
) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (
      ${botId}, ${options.name ?? botId}, NULL, 'crew', 'Coder', NULL, NULL,
      ${options.computerUse === true ? 1 : 0}, '2026-08-24T00:00:00.000Z', NULL
    )
  `;

const seedLimits = (sql: SqlClient.SqlClient, overrides: Record<string, number>) =>
  sql`
    INSERT INTO ade_limits_config (id, config_json, updated_at)
    VALUES (1, ${JSON.stringify(overrides)}, '2026-08-24T00:00:00.000Z')
  `;

const seedProvisioning = (sql: SqlClient.SqlClient, botId: string, status: string) =>
  sql`
    INSERT INTO ade_screenbox_provisionings (
      bot_id, status, container_ref, volume_ref, created_at, last_needed_at
    ) VALUES (
      ${botId}, ${status}, ${`screenbox-${botId}`}, ${`screenbox-${botId}-home`},
      '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
    )
  `;

const provisioningRow = (sql: SqlClient.SqlClient, botId: string) =>
  Effect.map(
    sql<{ status: string; last_needed_at: string | null }>`
      SELECT status, last_needed_at FROM ade_screenbox_provisionings WHERE bot_id = ${botId}
    `,
    (rows) => rows[0] ?? null,
  );

const openProvisionFailureItems = (sql: SqlClient.SqlClient) =>
  sql<{ needs_you_item_id: string; subject_refs_json: string; status: string }>`
    SELECT needs_you_item_id, subject_refs_json, status FROM ade_needs_you_items
    WHERE kind = 'provision-failure' AND status = 'open'
  `;

/** `it.effect` runs on the TestClock, so idling is an explicit clock advance. */
const idlePastWindow = TestClock.adjust(PAST_IDLE_WINDOW);

interface Harness {
  readonly mock: AdeScreenboxMock;
  readonly runtime: AdeScreenboxRuntimeShape;
  readonly plane: AdeScreenboxToolPlaneShape;
}

/** Boots the mock upstream and a runtime wired to it inside the test scope. */
const buildHarness = (
  options: {
    readonly configured?: boolean;
    readonly mcpSse?: boolean;
    readonly tools?: AdeScreenboxMockOptions["tools"];
    readonly controlDelayMs?: number;
  } = {},
): Effect.Effect<Harness, never, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const mockOptions: AdeScreenboxMockOptions = {
      ...(options.mcpSse === undefined ? {} : { mcpSse: options.mcpSse }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.controlDelayMs === undefined ? {} : { controlDelayMs: options.controlDelayMs }),
    };
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startAdeScreenboxMock(mockOptions)),
      (started) => Effect.promise(() => started.close()),
    );
    const context = yield* Layer.build(
      AdeScreenboxToolPlaneLive.pipe(
        Layer.provideMerge(AdeScreenboxRuntime.layer),
        Layer.provide(AdeScreenboxClient.layer),
        Layer.provide(
          AdeScreenboxConfig.layer({
            baseUrl: options.configured === false ? null : mock.baseUrl,
            adminToken: "admin-token",
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    );
    const runtime = yield* Effect.service(AdeScreenboxRuntime).pipe(Effect.provide(context));
    const plane = yield* Effect.service(AdeScreenboxToolPlane).pipe(Effect.provide(context));
    return { mock, runtime, plane };
  });

/** Deep search for a value anywhere in a forwarded argument payload. */
const mentionsAnywhere = (value: unknown, needle: string): boolean => {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => mentionsAnywhere(entry, needle));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => key.includes(needle) || mentionsAnywhere(entry, needle),
    );
  }
  return false;
};

const callContext = (botId: string, tool: string): AdeToolCallContext => ({
  botId: botId as BotId,
  purpose: "primary-text",
  engine: "shuvcode",
  sessionId: `session-${botId}` as never,
  tool,
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  return sql;
});

/** Each case gets its own in-memory database and its own mock upstream. */
const testCase = <E>(
  name: string,
  body: Effect.Effect<void, E, SqlClient.SqlClient | Scope.Scope>,
) =>
  it.effect(name, () =>
    Effect.scoped(body).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.orDie),
  );

describe("AdeScreenbox tool catalog", () => {
  testCase(
    "filters upstream tools/list to the operate-only subset",
    Effect.gen(function* () {
      yield* setup;
      const { runtime } = yield* buildHarness();
      const catalog = yield* runtime.refreshToolCatalog;
      const names = catalog.map((tool) => tool.name);
      assert.deepStrictEqual(names, ["desktop_screenshot", "desktop_click", "desktop_shell"]);
      assert.isFalse(names.includes("desktop_manage"));
      assert.isFalse(names.includes("knowledge_search"));
      for (const name of names) {
        assert.isTrue(SCREENBOX_OPERATE_TOOLS.includes(name));
      }
    }),
  );

  testCase(
    "recovers an empty catalog on a later sweep when Screenbox was down at boot",
    Effect.gen(function* () {
      yield* setup;
      const { mock, runtime } = yield* buildHarness();
      mock.failToolsList = true;

      // Boot pass with upstream down: nothing cached, so no desktop tools.
      yield* runtime.sweepIdleDesktops;
      assert.deepStrictEqual(yield* runtime.toolCatalog, []);

      // Upstream recovers; the next sweep repopulates without a restart.
      mock.failToolsList = false;
      yield* runtime.sweepIdleDesktops;
      assert.deepStrictEqual(
        (yield* runtime.toolCatalog).map((tool) => tool.name),
        ["desktop_screenshot", "desktop_click", "desktop_shell"],
      );
    }),
  );

  testCase(
    "keeps the last-good catalog when upstream tools/list fails",
    Effect.gen(function* () {
      yield* setup;
      const { mock, runtime } = yield* buildHarness();
      const first = yield* runtime.refreshToolCatalog;
      assert.isAbove(first.length, 0);
      mock.failToolsList = true;
      const second = yield* runtime.refreshToolCatalog;
      assert.deepStrictEqual(
        second.map((tool) => tool.name),
        first.map((tool) => tool.name),
      );
    }),
  );

  testCase(
    "parses SSE-framed MCP responses",
    Effect.gen(function* () {
      yield* setup;
      const { runtime } = yield* buildHarness({ mcpSse: true });
      const catalog = yield* runtime.refreshToolCatalog;
      assert.deepStrictEqual(
        catalog.map((tool) => tool.name),
        ["desktop_screenshot", "desktop_click", "desktop_shell"],
      );
    }),
  );

  testCase(
    "exposes no desktop tools for a bot without computer use, and none at all when unconfigured",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-off", { computerUse: false });
      yield* seedBot(sql, "bot-on", { computerUse: true });
      const { runtime, plane } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;
      assert.deepStrictEqual(
        yield* plane.toolsFor({ botId: "bot-off" as BotId, purpose: "primary-text" }),
        [],
      );
      const enabled = yield* plane.toolsFor({ botId: "bot-on" as BotId, purpose: "primary-text" });
      assert.isAbove(enabled.length, 0);

      const unconfigured = yield* buildHarness({ configured: false });
      yield* unconfigured.runtime.refreshToolCatalog;
      assert.deepStrictEqual(
        yield* unconfigured.plane.toolsFor({ botId: "bot-on" as BotId, purpose: "primary-text" }),
        [],
      );
      const eligibility = yield* unconfigured.plane.eligibility(
        callContext("bot-on", "desktop_click"),
      );
      assert.isFalse(eligibility.eligible);
    }),
  );
});

describe("AdeScreenbox scoping", () => {
  testCase(
    "forwards under the calling bot's desktop id even when input names another bot",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      yield* seedBot(sql, "bot-b", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;

      // Bot B holds a live desktop; bot A tries to name it.
      yield* runtime.ensureDesktopReady("bot-b" as BotId);
      const result = yield* runtime.forwardToolCall(callContext("bot-a", "desktop_shell"), {
        desktop_id: "bot-b",
        desktopId: "bot-b",
        agent_id: "bot-b",
        command: "whoami",
      });

      assert.strictEqual(result, "ok:desktop_shell:bot-a");
      assert.strictEqual(mock.toolCalls.length, 1);
      const call = mock.toolCalls[0]!;
      assert.strictEqual(call.arguments["desktop_id"], "bot-a");
      assert.strictEqual(call.arguments["command"], "whoami");
      assert.isUndefined(call.arguments["desktopId"]);
      assert.isUndefined(call.arguments["agent_id"]);
      // Bot A got its own desktop; bot B's is untouched.
      assert.isTrue(mock.desktops.has("bot-a"));
      assert.strictEqual(mock.desktops.get("bot-b")?.state, "running");
    }),
  );

  testCase(
    "strips desktop targets recursively and drops keys the upstream schema does not declare",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      yield* seedBot(sql, "bot-b", { computerUse: true });
      const { mock, runtime } = yield* buildHarness({
        tools: [
          {
            name: "desktop_batch",
            inputSchema: {
              type: "object",
              properties: { actions: { type: "array" }, stopOnError: { type: "boolean" } },
            },
          },
        ],
      });
      yield* runtime.refreshToolCatalog;
      yield* runtime.ensureDesktopReady("bot-b" as BotId);

      yield* runtime.forwardToolCall(callContext("bot-a", "desktop_batch"), {
        // Alternate spellings of the same targeting intent.
        desktopID: "bot-b",
        target_desktop: "bot-b",
        "Desktop-Id": "bot-b",
        containerId: "screenbox-bot-b",
        // Not declared by the schema: dropped by the allowlist.
        bogus: "payload",
        stopOnError: true,
        // Nested sub-invocations: `desktop_batch`'s whole reason to exist.
        actions: [
          { tool: "desktop_click", desktop_id: "bot-b", args: { x: 1, desktopID: "bot-b" } },
          { tool: "desktop_shell", command: "whoami", nested: { deep: { desktop: "bot-b" } } },
        ],
      });

      assert.strictEqual(mock.toolCalls.length, 1);
      const args = mock.toolCalls[0]!.arguments;
      assert.strictEqual(args["desktop_id"], "bot-a");
      assert.deepStrictEqual(Object.keys(args).sort(), ["actions", "desktop_id", "stopOnError"]);
      assert.deepStrictEqual(args["actions"], [
        { tool: "desktop_click", args: { x: 1 } },
        { tool: "desktop_shell", command: "whoami", nested: { deep: {} } },
      ]);
      // No spelling of bot B survived anywhere in the payload.
      assert.isFalse(mentionsAnywhere(args, "bot-b"));
      assert.strictEqual(mock.desktops.get("bot-b")?.state, "running");
    }),
  );

  testCase(
    "refuses tools outside the operate subset even if dispatch reaches the plane",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      const outcome = yield* runtime
        .forwardToolCall(callContext("bot-a", "desktop_manage"), { action: "destroy" })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(mock.toolCalls.length, 0);
      assert.strictEqual(mock.desktops.size, 0);
    }),
  );
});

describe("AdeScreenbox provisioning", () => {
  testCase(
    "provisions once for concurrent first calls and is idempotent afterwards",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;

      yield* Effect.all(
        [
          runtime.ensureDesktopReady("bot-a" as BotId),
          runtime.ensureDesktopReady("bot-a" as BotId),
          runtime.ensureDesktopReady("bot-a" as BotId),
        ],
        { concurrency: "unbounded" },
      );
      const creates = mock.requests.filter((request) => request.path === "/api/desktop/create");
      assert.strictEqual(creates.length, 1);
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");

      // A later call is a no-op beyond the idle touch.
      yield* runtime.ensureDesktopReady("bot-a" as BotId);
      assert.strictEqual(
        mock.requests.filter((request) => request.path === "/api/desktop/create").length,
        1,
      );
    }),
  );

  testCase(
    "sends the admin token upstream and never leaks it into tool arguments",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), { x: 1, y: 2 });
      assert.isTrue(
        mock.requests.every((request) => request.authorization === "Bearer admin-token"),
      );
      assert.deepStrictEqual(mock.toolCalls[0]!.arguments, { x: 1, y: 2, desktop_id: "bot-a" });
    }),
  );

  testCase(
    "records failure, raises one Needs You item, then resolves it on recovery",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      mock.failCreate = 2;

      const first = yield* runtime.ensureDesktopReady("bot-a" as BotId).pipe(Effect.result);
      assert.strictEqual(first._tag, "Failure");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "failed");
      assert.strictEqual((yield* openProvisionFailureItems(sql)).length, 1);

      // Second failure must not duplicate the alert (database-backed dedupe).
      yield* runtime.ensureDesktopReady("bot-a" as BotId).pipe(Effect.result);
      const items = yield* openProvisionFailureItems(sql);
      assert.strictEqual(items.length, 1);
      assert.isTrue(items[0]!.subject_refs_json.includes('"botId":"bot-a"'));

      // The next call retries and clears the item.
      yield* runtime.ensureDesktopReady("bot-a" as BotId);
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");
      assert.strictEqual((yield* openProvisionFailureItems(sql)).length, 0);
    }),
  );

  testCase(
    "surfaces a provisioning failure to the model as a tool failure",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      mock.failCreate = 1;
      const outcome = yield* runtime
        .forwardToolCall(callContext("bot-a", "desktop_click"), {})
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(mock.toolCalls.length, 0);
    }),
  );

  testCase(
    "refuses at the desktop cap naming the current occupants",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedLimits(sql, { maxConcurrentScreenboxDesktops: 2 });
      yield* seedBot(sql, "bot-a", { computerUse: true, name: "Coder" });
      yield* seedBot(sql, "bot-b", { computerUse: true, name: "Reviewer" });
      yield* seedBot(sql, "bot-c", { computerUse: true, name: "Researcher" });
      yield* seedProvisioning(sql, "bot-a", "running");
      yield* seedProvisioning(sql, "bot-b", "running");
      const { mock, runtime } = yield* buildHarness();

      const outcome = yield* runtime.ensureDesktopReady("bot-c" as BotId).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.kind, "cap-reached");
        assert.include(outcome.failure.reason, "Coder (bot-a)");
        assert.include(outcome.failure.reason, "Reviewer (bot-b)");
        assert.include(outcome.failure.reason, "2");
      }
      assert.strictEqual(
        mock.requests.filter((request) => request.path === "/api/desktop/create").length,
        0,
      );
      assert.isNull(yield* provisioningRow(sql, "bot-c"));

      // Stopping an occupant frees the slot (idle-stop is the cap relief).
      yield* sql`UPDATE ade_screenbox_provisionings SET status = 'stopped' WHERE bot_id = 'bot-a'`;
      yield* runtime.ensureDesktopReady("bot-c" as BotId);
      assert.strictEqual((yield* provisioningRow(sql, "bot-c"))?.status, "running");
    }),
  );

  testCase(
    "admits exactly one of two different bots racing for the last slot",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedLimits(sql, { maxConcurrentScreenboxDesktops: 4 });
      yield* seedBot(sql, "bot-1", { computerUse: true, name: "One" });
      yield* seedBot(sql, "bot-2", { computerUse: true, name: "Two" });
      yield* seedBot(sql, "bot-3", { computerUse: true, name: "Three" });
      yield* seedBot(sql, "bot-x", { computerUse: true, name: "Racer X" });
      yield* seedBot(sql, "bot-y", { computerUse: true, name: "Racer Y" });
      yield* seedProvisioning(sql, "bot-1", "running");
      yield* seedProvisioning(sql, "bot-2", "running");
      yield* seedProvisioning(sql, "bot-3", "running");
      const { mock, runtime } = yield* buildHarness();

      // 3/4 occupied: the per-bot mutex does nothing here, so only the
      // count+claim transaction can keep this at one winner.
      const outcomes = yield* Effect.all(
        [
          runtime.ensureDesktopReady("bot-x" as BotId).pipe(Effect.result),
          runtime.ensureDesktopReady("bot-y" as BotId).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
      assert.strictEqual(failures.length, 1);
      const refusal = failures[0]!;
      if (refusal._tag === "Failure") {
        assert.strictEqual(refusal.failure.kind, "cap-reached");
        assert.include(refusal.failure.reason, "One (bot-1)");
      }
      assert.strictEqual(
        mock.requests.filter((request) => request.path === "/api/desktop/create").length,
        1,
      );
      const active = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM ade_screenbox_provisionings
        WHERE status IN ('running', 'provisioning')
      `;
      assert.strictEqual(active[0]!.count, 4);
    }),
  );
});

describe("AdeScreenbox idle policy", () => {
  testCase(
    "stops an idle desktop and transparently restarts it on the next forward",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;

      yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), {});
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "running");

      // Idle past the LimitsConfig window.
      yield* idlePastWindow;
      yield* runtime.sweepIdleDesktops;
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "stopped");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "stopped");

      // Restart-on-need: the next forward starts the same desktop (no recreate)
      // and the tool call succeeds.
      const createsBefore = mock.requests.filter(
        (request) => request.path === "/api/desktop/create",
      ).length;
      const result = yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), {});
      assert.strictEqual(result, "ok:desktop_click:bot-a");
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "running");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");
      assert.strictEqual(
        mock.requests.filter((request) => request.path === "/api/desktop/create").length,
        createsBefore,
      );
    }),
  );

  testCase(
    "a forward racing the sweep still lands on a live desktop",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      // A slow upstream `control` widens the window in which the sweep's stop
      // and a live forward interleave.
      const { mock, runtime } = yield* buildHarness({ controlDelayMs: 40 });
      yield* runtime.refreshToolCatalog;
      yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), {});
      yield* idlePastWindow;

      const [, result] = yield* Effect.all(
        [
          runtime.sweepIdleDesktops,
          runtime.forwardToolCall(callContext("bot-a", "desktop_click"), { x: 1 }),
        ],
        { concurrency: "unbounded" },
      );

      // Whoever wins the bot's mutex, the other re-reads: the forward never
      // lands on a desktop the sweep just stopped.
      assert.strictEqual(result, "ok:desktop_click:bot-a");
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "running");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");
    }),
  );

  testCase(
    "keeps a desktop alive while a viewer is attached",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.ensureDesktopReady("bot-a" as BotId);
      yield* runtime.viewerAttached("bot-a" as BotId);

      yield* idlePastWindow;
      yield* runtime.sweepIdleDesktops;
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "running");
      assert.strictEqual((yield* runtime.statusFor("bot-a" as BotId)).viewers, 1);

      // Once the viewer leaves, the idle clock runs again.
      yield* runtime.viewerDetached("bot-a" as BotId);
      yield* idlePastWindow;
      yield* runtime.sweepIdleDesktops;
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "stopped");
    }),
  );

  testCase(
    "marks the record stopped when upstream says the desktop is not running",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;
      yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), {});

      // Stopped behind ADE's back; the record still says running.
      mock.desktops.get("bot-a")!.state = "stopped";
      const failed = yield* runtime
        .forwardToolCall(callContext("bot-a", "desktop_click"), {})
        .pipe(Effect.result);
      assert.strictEqual(failed._tag, "Failure");
      // The drift is recorded, so the NEXT call self-heals instead of waiting
      // for a sweep.
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "stopped");

      const result = yield* runtime.forwardToolCall(callContext("bot-a", "desktop_click"), {});
      assert.strictEqual(result, "ok:desktop_click:bot-a");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");
    }),
  );

  testCase(
    "recreates a desktop that vanished upstream while the record said running",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      const { mock, runtime } = yield* buildHarness();
      yield* runtime.ensureDesktopReady("bot-a" as BotId);

      // Out-of-band removal (operator ran `docker rm`, or upstream restarted).
      mock.desktops.delete("bot-a");
      yield* runtime.reconcileWithUpstream;
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "stopped");

      // `start` fails for a missing desktop, so the revive falls back to create.
      yield* runtime.ensureDesktopReady("bot-a" as BotId);
      assert.strictEqual(mock.desktops.get("bot-a")?.state, "running");
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "running");
    }),
  );

  testCase(
    "boot reconcile adopts upstream state for existing records",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      yield* seedBot(sql, "bot-b", { computerUse: true });
      yield* seedProvisioning(sql, "bot-a", "running");
      yield* seedProvisioning(sql, "bot-b", "stopped");
      const { mock, runtime } = yield* buildHarness();
      mock.desktops.set("bot-b", { state: "running" });

      yield* runtime.reconcileWithUpstream;
      assert.strictEqual((yield* provisioningRow(sql, "bot-a"))?.status, "stopped");
      assert.strictEqual((yield* provisioningRow(sql, "bot-b"))?.status, "running");
    }),
  );
});

describe("AdeScreenboxClient framing and configuration", () => {
  it("concatenates multi-line SSE data fields into one JSON-RPC frame", () => {
    const message = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "desktop_click" }] } };
    // A pretty-printed payload sent as one `data:` line per source line — the
    // shape that made a first-line-only parser return a truncated frame.
    const pretty = JSON.stringify(message, null, 2);
    const split = `event: message\n${pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n")}\n\n`;
    assert.isAbove(pretty.split("\n").length, 1);
    assert.deepStrictEqual(parseMcpResponseBody("text/event-stream", split), message);

    // A leading comment/heartbeat frame before the real one is skipped.
    const withNoise = `event: ping\ndata: {"jsonrpc":"2.0"}\n\n${split}`;
    assert.deepStrictEqual(parseMcpResponseBody("text/event-stream", withNoise), message);
  });

  it.effect("stays dormant when the configured origin is unusable", () =>
    Effect.gen(function* () {
      const config = yield* Effect.service(AdeScreenboxConfig).pipe(
        Effect.provide(
          AdeScreenboxConfig.layerFromEnv({
            SCREENBOX_API_URL: "screenbox.local:8080",
            SCREENBOX_API_TOKEN: "t",
          }),
        ),
      );
      assert.isNull(config.baseUrl);

      const ok = yield* Effect.service(AdeScreenboxConfig).pipe(
        Effect.provide(
          AdeScreenboxConfig.layerFromEnv({ SCREENBOX_API_URL: "http://127.0.0.1:8080/" }),
        ),
      );
      assert.strictEqual(ok.baseUrl, "http://127.0.0.1:8080");
      assert.isNull(ok.adminToken);
    }),
  );
});

describe("AdeScreenbox health probe", () => {
  testCase(
    "reports not-provisioned when unconfigured, healthy when up, down when unreachable",
    Effect.gen(function* () {
      yield* setup;
      const unconfigured = yield* buildHarness({ configured: false });
      assert.strictEqual((yield* unconfigured.runtime.probe).state, "not-provisioned");

      const { mock, runtime } = yield* buildHarness();
      assert.strictEqual((yield* runtime.probe).state, "healthy");
      mock.failHealth = true;
      const down = yield* runtime.probe;
      assert.strictEqual(down.state, "down");
      assert.isTrue((down.detail ?? "").length > 0);
    }),
  );
});

describe("AdeScreenbox through the tool gate", () => {
  const buildGate = (plane: AdeScreenboxToolPlaneShape) =>
    makeAdeToolGate({
      handlers: adeToolHandlersUnavailable,
      checks: {
        isRoutingTargetAllowed: () => Effect.succeed({ allowed: false, reason: "n/a" } as const),
        isAssignmentOwnedBy: () => Effect.succeed({ allowed: false, reason: "n/a" } as const),
      },
      screenbox: plane,
    });

  testCase(
    "dispatches operate tools for an eligible bot and denies everything else",
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* seedBot(sql, "bot-a", { computerUse: true });
      yield* seedBot(sql, "bot-off", { computerUse: false });
      const { mock, runtime, plane } = yield* buildHarness();
      yield* runtime.refreshToolCatalog;
      const gate = buildGate(plane);

      const catalog = yield* gate.catalogFor({ botId: "bot-a" as BotId, purpose: "primary-text" });
      const names = new Set(catalog.map((definition) => definition.name));
      assert.isTrue(names.has("desktop_click"));
      assert.isFalse(names.has("desktop_manage"));

      const ok = yield* gate.dispatch(callContext("bot-a", "desktop_click"), { x: 1 });
      assert.strictEqual(ok._tag, "completed");
      assert.strictEqual(mock.toolCalls[0]!.arguments["desktop_id"], "bot-a");

      // A computer-use-off bot carries no desktop tools at all, so the gate
      // resolves the name against an empty catalog: the denial is
      // `unknown-tool`, not a leak that such a tool exists elsewhere.
      const notEligible = yield* gate.dispatch(callContext("bot-off", "desktop_click"), {});
      assert.strictEqual(notEligible._tag, "denied");
      if (notEligible._tag === "denied") {
        assert.strictEqual(notEligible.denial._tag, "unknown-tool");
      }
      const eligibility = yield* plane.eligibility(callContext("bot-off", "desktop_click"));
      assert.isFalse(eligibility.eligible);
      // A bot without computer use never provisions anything.
      assert.isFalse(mock.desktops.has("bot-off"));

      const unknown = yield* gate.dispatch(callContext("bot-a", "desktop_manage"), {});
      assert.strictEqual(unknown._tag, "denied");
      if (unknown._tag === "denied") {
        assert.strictEqual(unknown.denial._tag, "unknown-tool");
      }
    }),
  );
});
