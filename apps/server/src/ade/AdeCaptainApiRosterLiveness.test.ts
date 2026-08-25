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

import * as Schema from "effect/Schema";

import { AdeRoster } from "@shuv2code/contracts";

import type { AdeBotChatSession, BotId, NeedsYouItemId } from "@shuv2code/contracts";

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
  /**
   * When the row *settled*, if that differs from when it was created. This is
   * the whole shape of a streamed reply: inserted on its first chunk, updated
   * when the turn finishes, and `created_at` never moves in between.
   */
  readonly settledAt?: string;
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
      ${input.settledAt ?? input.at}
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

  /**
   * D2 end to end: one frame carries the whole fleet, so a single message the
   * projection over-truncates does not degrade one row — it fails the frame and
   * the entire rail stops updating. Decoding the real `AdeRoster` is the only
   * assertion that covers that blast radius.
   */
  it.effect("produces a frame the wire contract actually accepts", () =>
    Effect.gen(function* () {
      const { api, bootstrap, firstmateId } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: `Shipping ${"🚢".repeat(400)} done`,
        at: "2026-08-24T10:00:00.000Z",
      });
      yield* say({
        botId: coder.botId,
        id: "m2",
        role: "assistant",
        text: "👨‍👩‍👧‍👦".repeat(200),
        at: "2026-08-24T10:01:00.000Z",
      });

      const roster = yield* api.getRoster();
      yield* Schema.decodeUnknownEffect(AdeRoster)(
        yield* Schema.encodeUnknownEffect(AdeRoster)(roster),
      );
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

  /**
   * D5: the runner injects assignment briefs as `role: "user"` because that is
   * the only role a kernel takes input on. Attributing them to the captain made
   * the rail print "You: Implement the retry budget…" — telling the captain
   * they said something the *fleet* said on their behalf.
   */
  it.effect("does not put words in the captain's mouth for an injected brief", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        // Verbatim the shape `AdeAssignmentRunner.ts:142` mints.
        id: "ade-assignment:asg_7:brief",
        role: "user",
        text: "Implement the retry budget and open a PR.",
        at: "2026-08-24T10:00:00.000Z",
      });

      const row = rowFor(yield* api.getRoster(), firstmateId);
      assert.equal(row?.lastMessage?.author, "system");
      assert.notEqual(row?.lastMessage?.author, "captain");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("does not put words in the captain's mouth for a synthetic delivery", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        // `OpenCodeV2Adapter.ts:194` shape.
        id: "msg_ade_5f2c9a",
        role: "user",
        text: "Code Monkey finished: retry budget landed.",
        at: "2026-08-24T10:00:00.000Z",
      });

      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.lastMessage?.author, "system");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still attributes a genuinely captain-typed message to the captain", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "user:01J9",
        role: "user",
        text: "ship it",
        at: "2026-08-24T10:00:00.000Z",
      });

      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.lastMessage?.author, "captain");
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

  /**
   * D6, and the nastiest of the set because it is permanent and silent.
   *
   * An assistant row is inserted when its first chunk arrives and keeps that
   * `created_at` for the whole turn; only `updated_at` moves when it settles.
   * A captain who is *watching the reply stream* and marks read mid-turn places
   * the mark after that row's `created_at` — so a `created_at`-keyed unread
   * predicate hides the finished message forever. The captain never sees a dot,
   * and the message they were literally watching arrive is the one they lose.
   */
  it.effect("counts a reply that settled after a mid-stream read", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      // The reply began before the captain looked...
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "Working on it… done, PR #12 is open.",
        at: "2026-08-24T10:00:00.000Z",
        // ...and settled after.
        settledAt: "2026-08-24T10:05:00.000Z",
      });

      // The captain marked read mid-turn, at 10:02.
      yield* sql`
        UPDATE ade_bots SET chat_last_read_at = '2026-08-24T10:02:00.000Z'
        WHERE bot_id = ${firstmateId}
      `;

      // Keyed on `created_at` this reads 0 — permanently. Settle time is what
      // makes it the 1 unread message it actually is.
      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.unreadCount, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("agrees with its own receipt about what is still unread", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* say({
        botId: firstmateId,
        id: "m1",
        role: "assistant",
        text: "settled long ago",
        at: "2026-08-24T10:00:00.000Z",
        settledAt: "2026-08-24T10:00:00.000Z",
      });
      yield* TestClock.setTime(Date.parse("2026-08-24T10:30:00.000Z"));

      // A receipt that disagreed with the next roster frame would make the
      // badge flicker back on by itself, which reads as a broken rail.
      const receipt = yield* api.markBotChatRead({ botId: firstmateId });
      assert.equal(receipt.unreadCount, 0);
      assert.equal(rowFor(yield* api.getRoster(), firstmateId)?.unreadCount, 0);
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

  it.effect("answers a secure request, and the secret reaches no durable column", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      yield* openNeedsYou({ id: "ny-1", kind: "form", botId: firstmateId });

      // `form` is `acknowledge`, not approve/deny (M5) — the same RPC and the
      // same item id `NeedsYouCard` submits, carrying the secret as the note.
      const answered = yield* api.submitNeedsYouDecision({
        needsYouItemId: "ny-1" as NeedsYouItemId,
        decision: "acknowledge",
        note: SECRET,
      });
      assert.equal(answered.item.status, "resolved");

      const roster = yield* api.getRoster();
      assert.notInclude(JSON.stringify(roster), SECRET);

      // Not into the item, and not into the tables the note *would* reach on
      // an approval path: `verdict_detail`, and the bot-facing instruction a
      // denial bounces into. Whole-table scans on purpose — asserting a
      // specific column would pass while the value sat one column over.
      const scans = yield* Effect.forEach(
        [
          sql<{
            blob: string;
          }>`SELECT COALESCE(subject_refs_json, '') AS blob FROM ade_needs_you_items`,
          sql<{
            blob: string;
          }>`SELECT COALESCE(verdict_detail, '') || ' ' || COALESCE(bounce_json, '') AS blob FROM ade_integration_candidates`,
          sql<{ blob: string }>`SELECT COALESCE(instruction, '') AS blob FROM ade_assignments`,
        ],
        (query) => query,
      );
      for (const rows of scans) {
        assert.notInclude(rows.map((row) => row.blob).join(" "), SECRET);
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("retires a secure request exactly once — the second answer is benign", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      yield* openNeedsYou({ id: "ny-1", kind: "form", botId: firstmateId });

      yield* api.submitNeedsYouDecision({
        needsYouItemId: "ny-1" as NeedsYouItemId,
        decision: "acknowledge",
        note: SECRET,
      });

      // The double-decision idempotency surface (MESSENGER-PIVOT §6 M5): the
      // conversation card and the inbox card are one item, so the second
      // submit — from either rendering — has to read as "already handled",
      // which is what `isBenignNeedsYouConflict` narrows on the client.
      const second = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "ny-1" as NeedsYouItemId,
          decision: "acknowledge",
          note: SECRET,
        }),
      );
      assert.equal(second.reason, "needs_you_already_resolved");

      const roster = yield* api.getRoster();
      assert.equal(rowFor(roster, firstmateId)?.attention, null);
      assert.notInclude(JSON.stringify(roster), SECRET);
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
