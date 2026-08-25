// @effect-diagnostics preferSchemaOverJson:off - The secret-absence assertions
// are deliberately schema-blind: their whole claim is that a string appears
// nowhere in the *encoded* payload, which a decoder would hide rather than
// prove. The `subject_refs_json` fixture is raw for the same reason — it has to
// be able to write a blob the schema would reject.
/**
 * Roster liveness against a real database
 * (`docs/ade/MESSENGER-PIVOT.md` §4/§6, ticket M3 / #196).
 *
 * `adeRosterLiveness.test.ts` pins what the projection is *allowed to say*;
 * this file pins what it actually reads. The two claims that can only be made
 * here are the arithmetic ones — unread across a read mark, and the mark's
 * monotonicity — plus the one that matters most: that a captain's answer to a
 * secure request has no path from `ade.submitNeedsYouDecision` onto the rail.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";

import type { AdeBotChatSession, AdeRoster, BotId, NeedsYouItemId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { AdeApprovalPort } from "./AdeApprovalPort.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeScreenboxRuntime } from "./AdeScreenbox.ts";
import { AdeScreenboxClient, AdeScreenboxConfig } from "./AdeScreenboxClient.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
import { ADE_BOT_THREAD_ID_PREFIX, ADE_UNREAD_DISPLAY_CAP } from "./adeRosterLiveness.ts";

const chatSession: AdeBotChatSession = {
  botId: "bot" as BotId,
  threadId: "ade-bot-bot" as AdeBotChatSession["threadId"],
  engine: "shuvcode",
  bindingId: "binding" as AdeBotChatSession["bindingId"],
  sessionId: "oc-1" as AdeBotChatSession["sessionId"],
  startedNow: true,
  toolsProbe: "attached",
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
          // The port is where a decision note *goes*. It is deliberately a
          // black hole here: the claim under test is that nothing on this side
          // of it can put the note back on the wire.
          submitIntegrationApproval: () => Effect.void,
          readCandidateStatus: () => Effect.succeed("awaiting-approval" as string | null),
        }),
        Layer.succeed(WorkspacePaths, {
          normalizeWorkspaceRoot: (root: string) => Effect.succeed(root),
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
  return { sql, bootstrap, api: yield* AdeCaptainApi, firstmateId: seeded.firstmateBotId };
});

/**
 * Append one settled message to a bot's primary thread.
 *
 * Written straight into `projection_thread_messages` rather than through the
 * chat session, because that is the honest fixture: an ADE bot chat *is* an
 * ordinary thread, so the projection is what the roster reads no matter which
 * kernel put the row there.
 */
const say = Effect.fn("say")(function* (input: {
  readonly botId: BotId;
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
  readonly streaming?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES (
      ${input.id},
      ${`${ADE_BOT_THREAD_ID_PREFIX}${input.botId}`},
      NULL,
      ${input.role},
      ${input.text},
      ${input.streaming === true ? 1 : 0},
      ${input.at},
      ${input.at}
    )
  `;
});

const openNeedsYou = Effect.fn("openNeedsYou")(function* (input: {
  readonly id: string;
  readonly kind: string;
  readonly botId: BotId;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO ade_needs_you_items
      (needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at)
    VALUES (
      ${input.id},
      ${input.kind},
      ${JSON.stringify([{ _tag: "bot", botId: input.botId }])},
      'open',
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:00:00.000Z',
      NULL
    )
  `;
});

const rowFor = (roster: AdeRoster, botId: BotId) =>
  roster.entries.find((entry) => entry.bot.id === botId);

describe("AdeCaptainApi.getRoster liveness", () => {
  it.effect("reads the tail of a bot's own thread and attributes it", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "user",
        text: "status?",
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* say({
        botId: firstmateId,
        id: "m2",
        role: "assistant",
        text: "All green.\nTwo PRs open.",
        at: "2026-08-24T10:05:00.000Z",
      });

      const row = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(row?.lastMessage?.preview, "All green. Two PRs open.");
      assert.equal(row?.lastMessage?.author, "bot");
      assert.equal(row?.lastMessage?.at, "2026-08-24T10:05:00.000Z");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("never reads another bot's thread into this bot's row", () =>
    Effect.gen(function* () {
      const { api, bootstrap, firstmateId } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      yield* say({
        botId: coder.botId,
        id: "m1",
        role: "assistant",
        text: "coder speaking",
        at: "2026-08-24T10:00:00.000Z",
      });

      const roster = yield* api.getRoster();
      assert.equal(rowFor(roster, coder.botId)?.lastMessage?.preview, "coder speaking");
      assert.equal(rowFor(roster, firstmateId)?.lastMessage, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps a half-streamed token out of the rail", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "settled",
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* say({
        botId: firstmateId,
        id: "m2",
        role: "assistant",
        text: "half a th",
        at: "2026-08-24T10:01:00.000Z",
        streaming: true,
      });

      const row = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(row?.lastMessage?.preview, "settled");
      assert.equal(row?.unreadCount, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("gives the amber line to the open approval and names the bot", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* openNeedsYou({ id: "ny-1", kind: "stall", botId: firstmateId });
      yield* openNeedsYou({ id: "ny-2", kind: "approval", botId: firstmateId });

      const row = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(row?.attention?.kind, "approval");
      assert.include(row?.attention?.line ?? "", "Approval required:");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("says nothing about a resolved item", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      yield* openNeedsYou({ id: "ny-1", kind: "approval", botId: firstmateId });
      yield* sql`UPDATE ade_needs_you_items SET status = 'resolved' WHERE needs_you_item_id = 'ny-1'`;

      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.attention, null);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.markBotChatRead", () => {
  /** The design's named test: unread arithmetic across a read mark. */
  it.effect("counts only the bot's messages, and only the ones after the mark", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "first",
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* say({
        botId: firstmateId,
        id: "m2",
        role: "assistant",
        text: "second",
        at: "2026-08-24T10:01:00.000Z",
      });

      // Never opened: everything the bot has said is unread.
      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.unreadCount, 2);

      // The mark is the *server's* clock, so the fixture has to place that
      // clock between the two halves of the conversation rather than hope the
      // host's wall time happens to fall there.
      yield* TestClock.setTime(Date.parse("2026-08-24T10:30:00.000Z"));
      const receipt = yield* api.markBotChatRead({ botId: firstmateId });
      assert.equal(receipt.readAt, "2026-08-24T10:30:00.000Z");
      assert.equal(receipt.unreadCount, 0);
      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.unreadCount, 0);

      // The captain's own reply is never unread to the captain.
      yield* say({
        botId: firstmateId,
        id: "m3",
        role: "user",
        text: "thanks",
        at: "2026-08-24T11:00:00.000Z",
      });
      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.unreadCount, 0);

      // The bot's next message is.
      yield* say({
        botId: firstmateId,
        id: "m4",
        role: "assistant",
        text: "welcome",
        at: "2026-08-24T11:01:00.000Z",
      });
      const after = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(after?.unreadCount, 1);
      assert.equal(after?.lastMessage?.preview, "welcome");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("only ever moves the mark forward", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      // A mark already in the future: a stale tab landing a read now must not
      // be able to rewind it and resurrect a cleared unread count.
      yield* sql`
        UPDATE ade_bots SET chat_last_read_at = '2099-01-01T00:00:00.000Z'
        WHERE bot_id = ${firstmateId}
      `;

      const receipt = yield* api.markBotChatRead({ botId: firstmateId });
      assert.equal(receipt.readAt, "2099-01-01T00:00:00.000Z");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a bot that does not exist rather than writing nothing quietly", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const result = yield* Effect.result(api.markBotChatRead({ botId: "bot_nope" as BotId }));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bot_not_found");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("stops counting at the badge's cap instead of scanning forever", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      for (let index = 0; index < ADE_UNREAD_DISPLAY_CAP + 20; index += 1) {
        yield* say({
          botId: firstmateId,
          id: `m${index}`,
          role: "assistant",
          text: `line ${index}`,
          at: `2026-08-24T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
        });
      }
      assert.equal(
        rowFor(yield* api.getRoster(), firstmateId)?.unreadCount,
        ADE_UNREAD_DISPLAY_CAP,
      );
    }).pipe(Effect.provide(makeLayer())),
  );
});

/**
 * The design's named test: **secret payloads absent from previews**.
 *
 * A secure request is a `form` Needs You item, and M5's `SecureInputCard`
 * answers it through `ade.submitNeedsYouDecision` — the secret rides the
 * decision `note`. Two independent things have to be true for the rail to be
 * safe, and both are asserted here rather than assumed:
 *
 * 1. While the request is open, the bot's row carries **no preview at all** —
 *    so even a captain who typed the value into the chat instead cannot have it
 *    quoted back at them in a list.
 * 2. After the decision, the note appears nowhere in the roster payload — the
 *    server forwards it to the approval port and never persists it.
 */
describe("secure answers and the roster preview", () => {
  const SECRET = "sk-live-51H-never-render-me";

  it.effect("withholds the preview while a secure request is open", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "What is the deploy key?",
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* say({
        botId: firstmateId,
        id: "m2",
        role: "user",
        text: SECRET,
        at: "2026-08-24T10:01:00.000Z",
      });
      yield* openNeedsYou({ id: "ny-1", kind: "form", botId: firstmateId });

      const roster = yield* api.getRoster();
      const row = rowFor(roster, firstmateId);
      assert.equal(row?.lastMessage, null);
      assert.equal(row?.attention?.kind, "form");
      assert.notInclude(JSON.stringify(roster), SECRET);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps a submitted decision note out of the roster entirely", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      yield* openNeedsYou({ id: "ny-1", kind: "form", botId: firstmateId });

      // `form` items are not approve/deny, so the decision is an acknowledge —
      // the same path `SecureInputCard` submits on, carrying the same note.
      yield* Effect.result(
        api.submitNeedsYouDecision({
          needsYouItemId: "ny-1" as NeedsYouItemId,
          decision: "acknowledge",
          note: SECRET,
        }),
      );

      const roster = yield* api.getRoster();
      assert.notInclude(JSON.stringify(roster), SECRET);
      // And it was not quietly written into the item either.
      const stored = yield* sql<{ blob: string }>`
        SELECT COALESCE(subject_refs_json, '') AS blob FROM ade_needs_you_items
      `;
      assert.notInclude(stored.map((row) => row.blob).join(" "), SECRET);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still previews a bot with an approval waiting — suppression is form-only", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "Checks passed.",
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* openNeedsYou({ id: "ny-1", kind: "approval", botId: firstmateId });

      const row = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(row?.lastMessage?.preview, "Checks passed.");
      assert.equal(row?.attention?.kind, "approval");
    }).pipe(Effect.provide(makeLayer())),
  );
});
