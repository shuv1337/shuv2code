import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import { AdeCreatedBotToolResult, BotId, KernelSessionId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeAssignmentEngine,
  AdeAssignmentKernelPort,
  type AdeAssignmentDeliveryBatch,
} from "./AdeAssignmentEngine.ts";
import { AdeAssignmentInlineChecks, AdeAssignmentToolHandlers } from "./AdeAssignmentTools.ts";
import { AdeMemoryToolHandlers } from "./AdeMemoryTools.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import {
  ADE_MAX_BOTS_PER_PROJECT,
  ADE_MAX_FLEET_BOTS,
  AdeFleetProvisioningInlineChecks,
  AdeFleetProvisioningToolHandlers,
} from "./AdeFleetProvisioningTools.ts";
import {
  AdeScreenboxToolPlane,
  AdeToolGate,
  AdeToolHandlers,
  AdeToolInlineChecks,
  type AdeToolCallContext,
  type AdeToolOutcome,
} from "./AdeToolGate.ts";

const AT = "2026-08-25T00:00:00.000Z";

const seedProject = (
  sql: SqlClient.SqlClient,
  projectId: string,
  secondMateBotId: string,
  name = projectId,
) =>
  sql`
    INSERT INTO ade_projects (
      project_id, name, second_mate_bot_id, repo_path, repo_remote,
      integration_policy_default, check_commands_json,
      shared_specialist_allow_list_json, limits_overrides_json, created_at, updated_at
    ) VALUES (
      ${projectId}, ${name}, ${secondMateBotId}, NULL, NULL,
      'agent-review', '[]', '"all"', NULL, ${AT}, ${AT}
    )
  `;

const seedBot = (
  sql: SqlClient.SqlClient,
  input: {
    botId: string;
    name?: string;
    role?: "firstmate" | "second-mate" | "crew" | "workspace-specialist";
    projectId?: string | null;
    archived?: boolean;
  },
) =>
  sql`
    INSERT INTO ade_bots (
      bot_id, name, display_meta_json, structural_role, role_tag,
      project_id, active_persona_version_id, computer_use, created_at, archived_at
    ) VALUES (
      ${input.botId}, ${input.name ?? input.botId}, NULL, ${input.role ?? "crew"}, 'Coder',
      ${input.projectId ?? null}, NULL, 0, ${AT}, ${input.archived === true ? AT : null}
    )
  `;

const ctxFor = (botId: string): AdeToolCallContext => ({
  botId: BotId.make(botId),
  purpose: "primary-text",
  engine: "shuvcode",
  sessionId: KernelSessionId.make(`session-${botId}`),
  tool: "create_bot",
});

interface CreatedBotResult {
  readonly botId: string;
  readonly name: string;
  readonly roleTag: string;
  readonly projectId: string | null;
  readonly summary: string;
}

const created = (outcome: AdeToolOutcome): CreatedBotResult => {
  assert.equal(outcome._tag, "completed");
  return JSON.parse(outcome._tag === "completed" ? outcome.content : "{}") as CreatedBotResult;
};

const denialReason = (outcome: AdeToolOutcome): string => {
  assert.equal(outcome._tag, "denied");
  if (outcome._tag !== "denied") return "";
  assert.equal(outcome.denial._tag, "bot-provisioning-not-allowed");
  return outcome.denial._tag === "bot-provisioning-not-allowed" ? outcome.denial.reason : "";
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;

  const gateLayer = AdeToolGate.layer.pipe(
    Layer.provide(
      AdeFleetProvisioningToolHandlers.layer.pipe(
        Layer.provide(AdeToolHandlers.layerUnavailable),
        Layer.provide(AdeBootstrap.layer),
      ),
    ),
    Layer.provide(
      AdeFleetProvisioningInlineChecks.layer.pipe(
        Layer.provide(AdeToolInlineChecks.layerFailClosed),
      ),
    ),
    Layer.provide(AdeScreenboxToolPlane.layerNotEligible),
  );
  const context = yield* Layer.build(gateLayer);
  const gate = yield* Effect.service(AdeToolGate).pipe(Effect.provide(context));
  return { sql, gate };
});

const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

describe("create_bot through the gate", () => {
  scenario("lets the Firstmate provision crew into an existing project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "reviewer",
        projectId: "project-a",
      });
      const result = created(outcome);
      assert.equal(result.name, "Reviewer");
      assert.equal(result.roleTag, "Reviewer");
      assert.equal(result.projectId, "project-a");
      assert.include(result.summary, "Reviewer");
      assert.include(result.summary, "project-a");
      assert.include(result.summary, "create_assignment");

      // Went through AdeBootstrap: persona v1 and an empty memory doc exist.
      const rows = yield* sql<{ name: string; structural_role: string; project_id: string }>`
        SELECT name, structural_role, project_id FROM ade_bots WHERE bot_id = ${result.botId}
      `;
      assert.equal(rows[0]?.structural_role, "crew");
      assert.equal(rows[0]?.project_id, "project-a");
      const personas = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_persona_versions WHERE bot_id = ${result.botId}
      `;
      assert.equal(personas[0]?.n, 1);
      const memory = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_memory_documents WHERE bot_id = ${result.botId}
      `;
      assert.equal(memory[0]?.n, 1);
    }),
  );

  scenario("makes a fleet-shared specialist when the Firstmate names no project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const omitted = created(
        yield* gate.dispatch(ctxFor("firstmate"), { templateId: "researcher" }),
      );
      assert.equal(omitted.projectId, null);
      assert.include(omitted.summary, "fleet-shared");

      const explicitNull = created(
        yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder", projectId: null }),
      );
      assert.equal(explicitNull.projectId, null);
    }),
  );

  scenario("refuses a specialist and crew: only coordinators provision", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      yield* seedBot(sql, { botId: "coder-a", role: "crew", projectId: "project-a" });
      yield* seedBot(sql, { botId: "shared", role: "workspace-specialist", projectId: null });

      const byCrew = yield* gate.dispatch(ctxFor("coder-a"), { templateId: "coder" });
      assert.include(denialReason(byCrew), "only coordinators");

      const bySpecialist = yield* gate.dispatch(ctxFor("shared"), { templateId: "coder" });
      assert.include(denialReason(bySpecialist), "only coordinators");

      const bots = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ade_bots`;
      assert.equal(bots[0]?.n, 3);
    }),
  );

  scenario("scopes a Second Mate to its own project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedProject(sql, "project-b", "mate-b");
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      yield* seedBot(sql, { botId: "mate-b", role: "second-mate", projectId: "project-b" });

      const own = created(
        yield* gate.dispatch(ctxFor("mate-a"), { templateId: "coder", projectId: "project-a" }),
      );
      assert.equal(own.projectId, "project-a");

      // Omitted resolves to the caller's project rather than fleet-shared.
      const implied = created(yield* gate.dispatch(ctxFor("mate-a"), { templateId: "researcher" }));
      assert.equal(implied.projectId, "project-a");

      const other = yield* gate.dispatch(ctxFor("mate-a"), {
        templateId: "coder",
        projectId: "project-b",
      });
      assert.include(denialReason(other), "its own project");

      const shared = yield* gate.dispatch(ctxFor("mate-a"), {
        templateId: "coder",
        projectId: null,
      });
      assert.include(denialReason(shared), "Firstmate");
    }),
  );

  scenario("refuses an unknown project", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "coder",
        projectId: "project-ghost",
      });
      assert.include(denialReason(outcome), "no project 'project-ghost' exists");
    }),
  );

  scenario("refuses reserved coordinator templates at the schema", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      for (const templateId of ["firstmate", "second-mate"]) {
        const outcome = yield* gate.dispatch(ctxFor("firstmate"), { templateId });
        assert.equal(outcome._tag, "denied");
        assert.equal(outcome._tag === "denied" ? outcome.denial._tag : "", "invalid-input");
      }
    }),
  );

  scenario("suffixes a colliding name, case-insensitively, across the fleet", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      // A live "reviewer" in *another* corner of the fleet still collides.
      yield* seedBot(sql, { botId: "existing", name: "reviewer", projectId: null });

      const second = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "reviewer",
          projectId: "project-a",
        }),
      );
      assert.equal(second.name, "Reviewer 2");

      // Repeating the *same* request is a replay, not a third Reviewer — the
      // suffix only advances for a genuinely different request.
      const replay = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "reviewer",
          projectId: "project-a",
        }),
      );
      assert.equal(replay.botId, second.botId);
      assert.equal(replay.name, "Reviewer 2");

      // A different template asking for the same name is a different request.
      const named = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "coder",
          projectId: "project-a",
          name: "Reviewer",
        }),
      );
      assert.equal(named.name, "Reviewer 3");
      assert.equal(named.roleTag, "Coder");
    }),
  );

  scenario("refuses at the per-project cap, naming the cap and the count", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      for (let index = 1; index < ADE_MAX_BOTS_PER_PROJECT; index += 1) {
        yield* seedBot(sql, { botId: `crew-${index}`, projectId: "project-a" });
      }
      // Archived crew does not count against the cap.
      yield* seedBot(sql, { botId: "retired", projectId: "project-a", archived: true });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "coder",
        projectId: "project-a",
      });
      const reason = denialReason(outcome);
      assert.include(reason, `cap of ${ADE_MAX_BOTS_PER_PROJECT} bots`);
      assert.include(reason, `(${ADE_MAX_BOTS_PER_PROJECT} active)`);
    }),
  );

  scenario("refuses at the fleet cap even for a fleet-shared specialist", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      for (let index = 1; index < ADE_MAX_FLEET_BOTS; index += 1) {
        yield* seedBot(sql, { botId: `shared-${index}`, projectId: null });
      }

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" });
      const reason = denialReason(outcome);
      assert.include(reason, `cap of ${ADE_MAX_FLEET_BOTS} bots`);
      assert.include(reason, `(${ADE_MAX_FLEET_BOTS} active)`);
    }),
  );

  scenario("refuses a caller that no longer exists", () =>
    Effect.gen(function* () {
      const { gate } = yield* setup;
      const outcome = yield* gate.dispatch(ctxFor("ghost"), { templateId: "coder" });
      assert.include(denialReason(outcome), "no longer exists");
    }),
  );

  // -- F1: projects are addressable by the name the captain actually says ----

  scenario("resolves projectId by exact project name, case- and space-insensitively", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-harbor", "mate-harbor", "Harbor");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, {
        botId: "mate-harbor",
        role: "second-mate",
        projectId: "project-harbor",
      });

      // The ticket's own acceptance: "create a reviewer bot for Harbor".
      const byName = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "reviewer",
          projectId: "Harbor",
        }),
      );
      assert.equal(byName.projectId, "project-harbor");
      assert.include(byName.summary, "Harbor");

      const byLooseName = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "coder",
          projectId: "  hArBoR ",
        }),
      );
      assert.equal(byLooseName.projectId, "project-harbor");

      // The id still works, and takes precedence over name matching.
      const byId = created(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "researcher",
          projectId: "project-harbor",
        }),
      );
      assert.equal(byId.projectId, "project-harbor");
    }),
  );

  scenario("refuses an ambiguous project name and names the candidates", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-one", "mate-one", "Harbor");
      yield* seedProject(sql, "project-two", "mate-two", "harbor");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-one", role: "second-mate", projectId: "project-one" });
      yield* seedBot(sql, { botId: "mate-two", role: "second-mate", projectId: "project-two" });

      const reason = denialReason(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "coder",
          projectId: "Harbor",
        }),
      );
      assert.include(reason, "matches 2 projects by name");
      assert.include(reason, "project-one");
      assert.include(reason, "project-two");
      assert.include(reason, "by id instead");
    }),
  );

  scenario("lets a Second Mate name its own project by name", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-harbor", "mate-harbor", "Harbor");
      yield* seedProject(sql, "project-other", "mate-other", "Dockyard");
      yield* seedBot(sql, {
        botId: "mate-harbor",
        role: "second-mate",
        projectId: "project-harbor",
      });
      yield* seedBot(sql, {
        botId: "mate-other",
        role: "second-mate",
        projectId: "project-other",
      });

      const own = created(
        yield* gate.dispatch(ctxFor("mate-harbor"), {
          templateId: "coder",
          projectId: "harbor",
        }),
      );
      assert.equal(own.projectId, "project-harbor");

      // Another project's *name* is scoped out exactly like its id.
      const other = denialReason(
        yield* gate.dispatch(ctxFor("mate-harbor"), {
          templateId: "coder",
          projectId: "Dockyard",
        }),
      );
      assert.include(other, "its own project");
    }),
  );

  scenario("refuses a project that matches neither an id nor a name", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-harbor", "mate-harbor", "Harbor");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, {
        botId: "mate-harbor",
        role: "second-mate",
        projectId: "project-harbor",
      });

      const reason = denialReason(
        yield* gate.dispatch(ctxFor("firstmate"), {
          templateId: "coder",
          projectId: "Drydock",
        }),
      );
      assert.include(reason, "no project 'Drydock' exists");
      assert.include(reason, "no project id and no project name");
    }),
  );

  // -- F2: persisted attribution -------------------------------------------

  scenario("records the provisioning bot on the created row", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const result = created(yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" }));
      const rows = yield* sql<{ created_by_bot_id: string | null }>`
        SELECT created_by_bot_id FROM ade_bots WHERE bot_id = ${result.botId}
      `;
      assert.equal(rows[0]?.created_by_bot_id, "firstmate");

      // The seeded Firstmate itself has no creator — null is a real value.
      const seeded = yield* sql<{ created_by_bot_id: string | null }>`
        SELECT created_by_bot_id FROM ade_bots WHERE bot_id = 'firstmate'
      `;
      assert.equal(seeded[0]?.created_by_bot_id, null);
    }),
  );

  // -- F3: durable idempotency ---------------------------------------------

  scenario("replays to the same bot instead of minting a suffixed twin", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const first = created(yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" }));
      const replay = created(yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" }));

      assert.equal(replay.botId, first.botId);
      assert.equal(replay.name, "Coder");
      assert.notInclude(replay.name, "2");
      assert.include(replay.summary, "already exists");
      assert.include(replay.summary, "no second bot was created");

      const count = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE structural_role = 'crew'
      `;
      assert.equal(count[0]?.n, 1);

      // A genuinely different request is not deduped.
      const different = created(
        yield* gate.dispatch(ctxFor("firstmate"), { templateId: "reviewer" }),
      );
      assert.notEqual(different.botId, first.botId);
    }),
  );

  scenario("frees the key once the bot is archived", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      const first = created(yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" }));
      yield* sql`UPDATE ade_bots SET archived_at = ${AT} WHERE bot_id = ${first.botId}`;

      // Replay protection claims the *live* bot only: re-hiring after
      // archiving is a legitimate request, not a permanent ban.
      const again = created(yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder" }));
      assert.notEqual(again.botId, first.botId);
      assert.equal(again.name, "Coder");
    }),
  );

  // -- F9: reserved coordinator names ---------------------------------------

  scenario("refuses a reserved coordinator display name", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });

      for (const name of ["Firstmate", "  firstmate ", "Second Mate", "SECOND MATE"]) {
        const reason = denialReason(
          yield* gate.dispatch(ctxFor("firstmate"), { templateId: "coder", name }),
        );
        assert.include(reason, "reserved coordinator name");
      }

      const crew = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE structural_role = 'crew'
      `;
      assert.equal(crew[0]?.n, 0);
    }),
  );

  // -- F7: the payload is the contract --------------------------------------

  scenario("emits a payload that decodes as AdeCreatedBotToolResult", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* setup;
      yield* seedProject(sql, "project-a", "mate-a", "Harbor");
      yield* seedBot(sql, { botId: "firstmate", role: "firstmate" });
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });

      const outcome = yield* gate.dispatch(ctxFor("firstmate"), {
        templateId: "reviewer",
        projectId: "Harbor",
      });
      assert.equal(outcome._tag, "completed");
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(AdeCreatedBotToolResult))(
        outcome._tag === "completed" ? outcome.content : "",
      );
      assert.equal(decoded.roleTag, "Reviewer");
      assert.equal(decoded.projectId, "project-a");
      assert.isNotEmpty(decoded.summary);
    }),
  );
});

// ---------------------------------------------------------------------------
// F10: the stack server.ts actually builds
// ---------------------------------------------------------------------------

/**
 * Every scenario above builds `create_bot` over the fail-closed base, which
 * proves the slice but not the composition. Layer stacking is exactly where a
 * patch-style seam breaks silently: one `AdeToolInlineChecks.of({...})` that
 * forgets to spread its base, and the *other* slice's checks revert to
 * deny-by-default with nothing failing to compile. So this mirrors
 * `server.ts`'s real order and asserts both slices still answer.
 */
const composedSetup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;

  const sends = yield* Ref.make<Array<AdeAssignmentDeliveryBatch>>([]);
  const portLayer = Layer.succeed(AdeAssignmentKernelPort, {
    kernelHealth: () => Effect.succeed({ available: true } as const),
    deliverResults: (batch: AdeAssignmentDeliveryBatch) =>
      Ref.update(sends, (all) => [...all, batch]),
    steerPrimary: () => Effect.void,
    isSessionLive: () => Effect.succeed(true),
  });

  // Same order as AdeToolHandlersLayerLive / AdeToolGateLayerLive.
  const handlers = AdeFleetProvisioningToolHandlers.layer.pipe(
    Layer.provide(AdeMemoryToolHandlers.layer),
    Layer.provide(AdeAssignmentToolHandlers.layer),
    Layer.provide(AdeToolHandlers.layerUnavailable),
  );
  const checks = AdeFleetProvisioningInlineChecks.layer.pipe(
    Layer.provide(AdeAssignmentInlineChecks.layer),
  );
  const gateLayer = AdeToolGate.layer.pipe(
    Layer.provide(handlers),
    Layer.provide(checks),
    Layer.provide(AdeScreenboxToolPlane.layerNotEligible),
    Layer.provideMerge(AdeAssignmentEngine.layer.pipe(Layer.provide(portLayer))),
    Layer.provideMerge(AdeBootstrap.layer),
    Layer.provideMerge(AdePersonaMemory.layer),
    Layer.provideMerge(portLayer),
  );
  const context = yield* Layer.build(gateLayer);
  const gate = yield* Effect.service(AdeToolGate).pipe(Effect.provide(context));
  return { sql, gate };
});

describe("create_bot on the server's composed stack", () => {
  scenario("keeps routing denials and create_bot working through one gate", () =>
    Effect.gen(function* () {
      const { sql, gate } = yield* composedSetup;
      yield* seedProject(sql, "project-a", "mate-a", "Harbor");
      yield* seedProject(sql, "project-b", "mate-b", "Dockyard");
      yield* seedBot(sql, { botId: "mate-a", role: "second-mate", projectId: "project-a" });
      yield* seedBot(sql, { botId: "mate-b", role: "second-mate", projectId: "project-b" });
      yield* seedBot(sql, { botId: "coder-b", role: "crew", projectId: "project-b" });

      // S7's check still answers: another project's crew is not routable.
      const routing = yield* gate.dispatch(
        { ...ctxFor("mate-a"), tool: "create_assignment" },
        { recipientBotId: "coder-b", instruction: "someone else's crew" },
      );
      assert.equal(routing._tag, "denied");
      assert.equal(
        routing._tag === "denied" ? routing.denial._tag : "",
        "routing-target-not-allowed",
      );

      // M9's check answers on the same gate, by project name.
      const provisioned = created(
        yield* gate.dispatch(ctxFor("mate-a"), { templateId: "reviewer", projectId: "Harbor" }),
      );
      assert.equal(provisioned.projectId, "project-a");

      // And the bot it just made is immediately assignable — the whole point.
      const assigned = yield* gate.dispatch(
        { ...ctxFor("mate-a"), tool: "create_assignment" },
        { recipientBotId: provisioned.botId, instruction: "review the candidate" },
      );
      assert.equal(assigned._tag, "completed");

      // S8's handler is still wired too (the third slice in the stack), and
      // the bot create_bot just made has a real memory document to write to.
      const memory = yield* gate.dispatch(
        { ...ctxFor(provisioned.botId), tool: "update_memory" },
        { content: "harbor notes" },
      );
      assert.equal(memory._tag, "completed");

      // fleet_read now carries the name and the attribution.
      const fleet = yield* gate.dispatch({ ...ctxFor("mate-a"), tool: "fleet_read" }, {});
      assert.equal(fleet._tag, "completed");
      const view = JSON.parse(fleet._tag === "completed" ? fleet.content : "{}") as {
        bots: ReadonlyArray<{
          botId: string;
          projectName: string | null;
          createdByBotId: string | null;
        }>;
      };
      const row = view.bots.find((bot) => bot.botId === provisioned.botId);
      assert.equal(row?.projectName, "Harbor");
      assert.equal(row?.createdByBotId, "mate-a");
    }),
  );
});
