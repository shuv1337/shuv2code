/**
 * Loose bot identity: rename, decoration, role tag, contact groups
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M2 / #197).
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

import { AdeUpdateBotIdentityInput } from "@shuv2code/contracts";

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

/**
 * Decoding is what the wire does before a handler ever runs, so a bounds test
 * that skipped it would be asserting against a payload no client could send.
 */
const decodeIdentityInput = Schema.decodeUnknownEffect(AdeUpdateBotIdentityInput);

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
  toolsProbe: "attached",
  toolsAttached: true,
  modelHealth: "ok" as const,
  modelSlug: null,
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

  /**
   * "Backend" and "backend" are the same header to the person reading the
   * rail, so they are the same group to the server.
   */
  it.effect("treats a differently-cased name as the same header", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });

      // Trimming happens at the wire (`AdeBotGroupName` is a trimmed schema),
      // so what reaches the service differs from the stored name only in case.
      const result = yield* Effect.result(
        api.upsertBotGroup({ name: "bAcKeNd" as AdeBotGroupName }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_group_name_conflict");
      }
      // Renaming a group to its own name in another case is not a conflict
      // with itself — it is just a re-case, and it must go through.
      const groups = (yield* api.getRoster()).groups;
      const only = groups[0];
      assert.isDefined(only);
      const recased = yield* api.upsertBotGroup({
        groupId: only!.id,
        name: "BACKEND" as AdeBotGroupName,
      });
      assert.equal(recased.name, "BACKEND");
      assert.equal(recased.id, only!.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  /**
   * The rename branch refuses a collision too, and refuses it as a *name*
   * conflict. `persistence_failed` ("The change could not be saved.") would
   * tell the captain nothing about the one thing they can act on.
   */
  it.effect("refuses a rename onto another group's header", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      yield* api.upsertBotGroup({ name: "Backend" as AdeBotGroupName });
      const frontend = yield* api.upsertBotGroup({ name: "Frontend" as AdeBotGroupName });

      const result = yield* Effect.result(
        api.upsertBotGroup({ groupId: frontend.id, name: "backend" as AdeBotGroupName }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_group_name_conflict");
      }
      // Refused, not half-applied: the other group kept its header.
      const groups = (yield* api.getRoster()).groups;
      assert.deepEqual(groups.map((group) => group.name).toSorted(), ["Backend", "Frontend"]);
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

/**
 * `BotDisplayMeta` is a first-writer surface: the captain types straight into
 * it, and the result is stored, re-served, and painted on the rail, the
 * conversation header and the avatar. The bounds belong on the server, not
 * only on the sheet's `maxLength`.
 */
describe("AdeCaptainApi bot display metadata bounds", () => {
  const rejects = (displayMeta: unknown) =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      const before = yield* api.getBot(coder.botId);

      const result = yield* Effect.result(decodeIdentityInput({ botId: coder.botId, displayMeta }));

      assert.equal(result._tag, "Failure");
      // Nothing was written on the way to the refusal.
      const after = yield* api.getBot(coder.botId);
      assert.deepEqual(after.bot.displayMeta, before.bot.displayMeta);
    }).pipe(Effect.provide(makeLayer()));

  it.effect("refuses an emoji past 32 code units", () => rejects({ emoji: "🤖".repeat(20) }));

  it.effect("refuses control characters in the emoji", () => rejects({ emoji: "a\u0000b" }));

  it.effect("refuses a bidi override in the emoji", () => rejects({ emoji: "a\u202eb" }));

  it.effect("refuses a color outside the palette", () => rejects({ color: "chartreuse" }));

  it.effect("refuses a description past 280 characters", () =>
    rejects({ description: "d".repeat(281) }),
  );

  /**
   * The bounds tightened after the column existed, so a row could hold a blob
   * the contract now refuses. That must degrade to "no decoration", not to a
   * roster that will not load — the failure would otherwise land on the way
   * *out*, where nothing can do anything about it.
   */
  it.effect("drops an unpaintable stored decoration instead of failing the read", () =>
    Effect.gen(function* () {
      const { api, bootstrap, sql } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      // A hex color and a bidi override: both were storable before the
      // bounds landed, and neither is paintable now.
      const legacy = `{"color":"#224466","emoji":"a\u202eb"}`;
      yield* sql`
        UPDATE ade_bots SET display_meta_json = ${legacy} WHERE bot_id = ${coder.botId}
      `;

      const detail = yield* api.getBot(coder.botId);
      const roster = yield* api.getRoster();

      assert.equal(detail.bot.displayMeta, null);
      assert.equal(
        roster.entries.find((entry) => entry.bot.id === coder.botId)?.bot.displayMeta,
        null,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("accepts a decoration inside every bound", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const input = yield* decodeIdentityInput({
        botId: coder.botId,
        displayMeta: { emoji: "🛠️", color: "amber", description: "Ships fixes." },
      });
      const updated = yield* api.updateBotIdentity(input);

      assert.deepEqual(updated.displayMeta, {
        emoji: "🛠️",
        color: "amber",
        description: "Ships fixes.",
      });
    }).pipe(Effect.provide(makeLayer())),
  );
});
