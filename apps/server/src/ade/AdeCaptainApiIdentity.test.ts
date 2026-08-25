/**
 * Loose bot identity: rename, decoration, role tag, contact groups
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket T2 / #197).
 *
 * These live beside `AdeCaptainApi.test.ts` rather than inside it because the
 * claims are about a boundary rather than about a projection: what a captain
 * *may* relabel, what the server keeps for itself, and what a group delete is
 * allowed to reach.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { FetchHttpClient } from "effect/unstable/http";

import type {
  AdeBotChatSession,
  AdeBotGroupId,
  AdeBotGroupName,
  BotId,
  BotName,
  BotRoleTag,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeApprovalPort } from "./AdeApprovalPort.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeScreenboxRuntime } from "./AdeScreenbox.ts";
import { AdeScreenboxClient, AdeScreenboxConfig } from "./AdeScreenboxClient.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

class StubWorkspacePathError extends Schema.TaggedErrorClass<StubWorkspacePathError>()(
  "StubWorkspacePathError",
  { message: Schema.String },
) {}

const chatSession: AdeBotChatSession = {
  botId: "bot" as BotId,
  threadId: "ade-bot-bot" as AdeBotChatSession["threadId"],
  engine: "shuvcode",
  bindingId: "binding" as AdeBotChatSession["bindingId"],
  sessionId: "oc-1" as AdeBotChatSession["sessionId"],
  startedNow: true,
  toolsAttached: true,
};

const makeLayer = () =>
  AdeCaptainApi.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdePersonaMemory.layer,
        AdeSessionRollover.layer,
        AdeAssignmentEngine.layer,
        AdeScreenboxRuntime.layer.pipe(
          Layer.provide(AdeScreenboxClient.layer),
          Layer.provide(AdeScreenboxConfig.layer({ baseUrl: null, adminToken: "admin-token" })),
          Layer.provide(FetchHttpClient.layer),
        ),
        Layer.succeed(AdeChatSessionPort, {
          startPrimaryChat: (botId: BotId) => Effect.succeed({ ...chatSession, botId }),
        }),
        Layer.succeed(AdeApprovalPort, {
          submitIntegrationApproval: () => Effect.void,
          readCandidateStatus: () => Effect.succeed("awaiting-approval" as string | null),
        }),
        Layer.succeed(WorkspacePaths, {
          normalizeWorkspaceRoot: (root: string) =>
            root.startsWith("~/repos/demo")
              ? Effect.succeed("/normalized/repos/demo")
              : Effect.fail(
                  new StubWorkspacePathError({ message: `workspace root does not exist: ${root}` }),
                ),
        } as unknown as WorkspacePaths["Service"]),
      ),
    ),
    Layer.provide(AdeAssignmentKernelPort.layerUnwired),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return {
    sql,
    bootstrap,
    api: yield* AdeCaptainApi,
    firstmateId: seeded.firstmateBotId,
  };
});

describe("AdeCaptainApi.updateBotIdentity", () => {
  it.effect("renames the Firstmate — permanence protects existence, not the label", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;

      const renamed = yield* api.updateBotIdentity({
        botId: firstmateId,
        name: "Number One" as BotName,
      });

      assert.equal(renamed.name, "Number One");
      // The rule the Firstmate actually has is still in force.
      assert.equal(renamed.structuralRole, "firstmate");
      const deleted = yield* Effect.result(api.deleteBot(firstmateId));
      assert.equal(deleted._tag, "Failure");
      if (deleted._tag === "Failure") {
        assert.equal(deleted.failure.reason, "firstmate_permanent");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("patches only the fields present, leaving the rest untouched", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const decorated = yield* api.updateBotIdentity({
        botId: coder.botId,
        displayMeta: { emoji: "🛠️", color: "amber" },
      });
      assert.deepEqual(decorated.displayMeta, { emoji: "🛠️", color: "amber" });
      const originalName = decorated.name;

      // A rename-only patch must not wipe the decoration that landed first.
      const renamed = yield* api.updateBotIdentity({
        botId: coder.botId,
        name: "Wrench" as BotName,
      });
      assert.equal(renamed.name, "Wrench");
      assert.notEqual(originalName, "Wrench");
      assert.deepEqual(renamed.displayMeta, { emoji: "🛠️", color: "amber" });

      // Explicit null is the only way to clear, and it clears only that field.
      const cleared = yield* api.updateBotIdentity({
        botId: coder.botId,
        displayMeta: null,
      });
      assert.equal(cleared.displayMeta, null);
      assert.equal(cleared.name, "Wrench");
      assert.equal(cleared.roleTag, renamed.roleTag);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("cannot move structuralRole or template lineage in either direction", () =>
    Effect.gen(function* () {
      const { api, bootstrap, sql } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      const before = yield* api.getBot(coder.botId);

      // Direction 1 — not settable via the RPC. `AdeUpdateBotIdentityInput`
      // has no key for either, so the only way to ask is to smuggle extra
      // properties past the type; the handler must ignore them rather than
      // pass them through to SQL.
      const smuggled = {
        botId: coder.botId,
        name: "Relabelled" as BotName,
        structuralRole: "firstmate",
        templateId: "researcher",
        projectId: "proj-somewhere",
        activePersonaVersionId: null,
      } as unknown as Parameters<typeof api.updateBotIdentity>[0];
      const after = yield* api.updateBotIdentity(smuggled);

      assert.equal(after.name, "Relabelled");
      assert.equal(after.structuralRole, before.bot.structuralRole);
      assert.equal(after.projectId, before.bot.projectId);
      assert.equal(after.activePersonaVersionId, before.bot.activePersonaVersionId);
      assert.equal(after.createdAt, before.bot.createdAt);

      // Direction 2 — not present in the write payload. The persisted row is
      // the check that matters: a second Firstmate would have tripped 055's
      // partial unique index, and the role column is verbatim what it was.
      const rows = yield* sql<{ structural_role: string }>`
        SELECT structural_role FROM ade_bots WHERE bot_id = ${coder.botId}
      `;
      assert.equal(rows[0]?.structural_role, "crew");
      const firstmates = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ade_bots WHERE structural_role = 'firstmate'
      `;
      assert.equal(firstmates[0]?.n, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a membership in a group that does not exist", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const result = yield* Effect.result(
        api.updateBotIdentity({ botId: coder.botId, groupId: "ghost" as AdeBotGroupId }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_group_not_found");
      }
      // Rejected, not silently ungrouped: the bot is where it was.
      const unchanged = yield* api.getBot(coder.botId);
      assert.equal(unchanged.bot.groupId, null);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi bot groups", () => {
  it.effect("creates, renames and lists groups in rail order", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;

      const backend = yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });
      const frontend = yield* api.upsertBotGroup({ name: "Frontend" as AdeBotGroupName });
      assert.isBelow(backend.orderIndex, frontend.orderIndex);

      const renamed = yield* api.upsertBotGroup({
        groupId: backend.id,
        name: "Platform" as AdeBotGroupName,
      });
      assert.equal(renamed.id, backend.id);
      assert.equal(renamed.name, "Platform");
      assert.equal(renamed.createdAt, backend.createdAt);

      const roster = yield* api.getRoster();
      assert.deepEqual(
        roster.groups.map((group) => group.name),
        ["Platform", "Frontend"],
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a duplicate group name rather than merging two headers", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });

      const result = yield* Effect.result(
        api.upsertBotGroup({ name: "Backend" as AdeBotGroupName }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_group_name_conflict");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("deleting a group ungroups its members and deletes no bot", () =>
    Effect.gen(function* () {
      const { api, bootstrap, firstmateId } = yield* setup;
      const group = yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      const reviewer = yield* bootstrap.instantiateTemplate({
        templateId: "reviewer",
        projectId: null,
      });
      yield* api.updateBotIdentity({ botId: coder.botId, groupId: group.id });
      yield* api.updateBotIdentity({ botId: reviewer.botId, groupId: group.id });
      yield* api.updateBotIdentity({ botId: firstmateId, groupId: group.id });

      const deleted = yield* api.deleteBotGroup({ groupId: group.id });

      assert.deepEqual(
        [...deleted.ungroupedBotIds].toSorted(),
        [coder.botId, firstmateId, reviewer.botId].toSorted(),
      );

      const roster = yield* api.getRoster();
      assert.deepEqual(roster.groups, []);
      // Every member is still a bot; the delete reached the bucket only.
      const ids = roster.entries.map((entry) => entry.bot.id).toSorted();
      assert.deepEqual(ids, [coder.botId, firstmateId, reviewer.botId].toSorted());
      assert.isTrue(roster.entries.every((entry) => entry.bot.groupId === null));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("reports a delete of a group that is already gone", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;

      const result = yield* Effect.result(
        api.deleteBotGroup({ groupId: "ghost" as AdeBotGroupId }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_group_not_found");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("carries group membership onto every roster row", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const group = yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      yield* api.updateBotIdentity({
        botId: coder.botId,
        groupId: group.id,
        roleTag: "Fixer" as BotRoleTag,
      });

      const roster = yield* api.getRoster();
      const entry = roster.entries.find((row) => row.bot.id === coder.botId);

      assert.equal(entry?.bot.groupId, group.id);
      assert.equal(entry?.bot.roleTag, "Fixer");
    }).pipe(Effect.provide(makeLayer())),
  );
});
