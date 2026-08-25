import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  KernelSessionId,
  NeedsYouItemId,
  type BotId,
  type NeedsYouSubjectRef,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AdeAssignmentKernelPort,
  adeAssignmentKernelPortUnwired,
  type AdeAssignmentDeliveryBatch,
} from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import {
  AdeSessionRollover,
  UNTRUSTED_CONTENT_OPEN,
  renderSessionProjection,
} from "./AdeSessionRollover.ts";
import { AdeToolGate } from "./AdeToolGate.ts";
import {
  ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS,
  AdeVoiceApprovalTokenRejectedError,
  ADE_VOICE_CAPTAIN_APPROVAL_TOOLS,
  ADE_VOICE_COMMIT_APPROVAL_TOOL,
  ADE_VOICE_PREPARE_APPROVAL_TOOL,
  AdeVoiceApprovalPort,
  AdeVoiceChannel,
  AdeVoicePrimaryTranscript,
  type AdeVoiceTranscriptMessage,
} from "./AdeVoiceChannel.ts";

/** Assert the fail-closed refusal and narrow to it, so `reason` is readable. */
const expectTokenRejection = (error: {
  readonly _tag: string;
}): AdeVoiceApprovalTokenRejectedError => {
  assert.strictEqual(error._tag, "AdeVoiceApprovalTokenRejectedError");
  return error as AdeVoiceApprovalTokenRejectedError;
};

/** Every kernel-port call the channel makes, in order — including steers. */
interface RecordedKernelCall {
  readonly operation: "deliverResults" | "steerPrimary";
  readonly batch?: AdeAssignmentDeliveryBatch;
  readonly steerText?: string;
}

const makeLayer = (input: {
  readonly recorded: Array<RecordedKernelCall>;
  readonly messages?: ReadonlyArray<AdeVoiceTranscriptMessage>;
}) => {
  const kernelPort = Layer.succeed(AdeAssignmentKernelPort, {
    ...adeAssignmentKernelPortUnwired,
    deliverResults: (batch: AdeAssignmentDeliveryBatch) =>
      Effect.sync(() => {
        input.recorded.push({ operation: "deliverResults", batch });
      }),
    steerPrimary: (steer: { readonly text: string }) =>
      Effect.sync(() => {
        input.recorded.push({ operation: "steerPrimary", steerText: steer.text });
      }),
  });
  const transcript = Layer.succeed(AdeVoicePrimaryTranscript, {
    recentMessages: () => Effect.succeed(input.messages ?? []),
  });
  return AdeVoiceChannel.layer.pipe(
    Layer.provide(kernelPort),
    Layer.provide(transcript),
    Layer.provide(AdeToolGate.layerFailClosed),
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdePersonaMemory.layer,
        AdeSessionRollover.layer,
        AdeVoiceApprovalPort.layerSql,
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return {
    sql,
    channel: yield* AdeVoiceChannel,
    rollover: yield* AdeSessionRollover,
    memory: yield* AdePersonaMemory,
    botId: seeded.firstmateBotId,
  };
});

/** Insert one open `approval` Needs You item, the way S7/S14 producers do. */
const seedApprovalItem = (
  sql: SqlClient.SqlClient,
  input: { readonly id: string; readonly refs: ReadonlyArray<NeedsYouSubjectRef> },
) =>
  sql`
    INSERT INTO ade_needs_you_items (
      needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
    ) VALUES (
      ${input.id}, 'approval', ${JSON.stringify(input.refs)}, 'open',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;

const needsYouStatus = (sql: SqlClient.SqlClient, id: string) =>
  Effect.map(
    sql<{ status: string }>`
      SELECT status FROM ade_needs_you_items WHERE needs_you_item_id = ${id}
    `,
    (rows) => rows[0]?.status ?? null,
  );

/** Open the bot's primary text session so end-of-call delivery has a target. */
const startPrimary = (rollover: AdeSessionRollover["Service"], botId: BotId) =>
  rollover.startPrimarySession({
    botId,
    engine: "shuvcode",
    sessionId: KernelSessionId.make("primary-session-1"),
  });

// ---------------------------------------------------------------------------

describe("AdeVoiceChannel two-phase verbal approvals", () => {
  it.effect("refuses a commit with no prepared token — nothing is approved", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-1", refs: [{ _tag: "bot", botId }] });

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-1"),
        captainChannel: true,
      });

      // A model that skipped prepare_approval entirely and invented a token.
      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-1"),
          token: "definitely-not-a-real-token",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "unknown-token");

      // Fail closed means the durable item is untouched.
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-1"), "open");
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("refuses a commit once the confirmation token has expired", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, {
        id: "needs-you-2",
        refs: [{ _tag: "bot", botId }],
      });

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-2"),
        captainChannel: true,
      });

      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-2"),
      });
      // Phase 1 approves nothing on its own.
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-2"), "open");
      assert.include(prepared.restatement, "needs-you-2");
      assert.include(prepared.restatement, "approval");

      // The captain took too long to answer.
      yield* TestClock.adjust(Duration.millis(ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS));

      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-2"),
          token: prepared.token,
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "expired-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-2"), "open");
    }).pipe(Effect.provide(makeLayer({ recorded })), Effect.provide(TestClock.layer()));
  });

  it.effect("commits inside the window, and the token is single-use", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-3", refs: [{ _tag: "bot", botId }] });

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-3"),
        captainChannel: true,
      });
      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-3"),
      });

      yield* TestClock.adjust(Duration.millis(ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS - 1));
      const committed = yield* channel.commitApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-3"),
        token: prepared.token,
      });
      assert.deepStrictEqual(committed, {
        needsYouItemId: NeedsYouItemId.make("needs-you-3"),
        decision: "approve",
        settled: true,
      });
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-3"), "resolved");

      // Replaying the same spoken token must not settle anything a second time.
      const replay = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-3"),
          token: prepared.token,
        }),
      );
      assert.strictEqual(expectTokenRejection(replay).reason, "unknown-token");
    }).pipe(Effect.provide(makeLayer({ recorded })), Effect.provide(TestClock.layer()));
  });

  it.effect("keeps the approval tools off a non-captain call", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-4", refs: [{ _tag: "bot", botId }] });

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-4"),
      });

      // Not in the catalog...
      const names = call.tools.map((tool) => tool.name);
      assert.notInclude(names, ADE_VOICE_PREPARE_APPROVAL_TOOL);
      assert.notInclude(names, ADE_VOICE_COMMIT_APPROVAL_TOOL);

      // ...and unknown at dispatch, not merely undeclared.
      const outcome = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: ADE_VOICE_PREPARE_APPROVAL_TOOL,
        input: { needsYouId: "needs-you-4" },
      });
      assert.deepStrictEqual(outcome, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: ADE_VOICE_PREPARE_APPROVAL_TOOL },
      });

      const refused = yield* Effect.flip(
        channel.prepareApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-4"),
        }),
      );
      assert.strictEqual(refused._tag, "AdeVoiceApprovalNotPermittedError");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-4"), "open");
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });
});

describe("AdeVoiceChannel call surface", () => {
  it.effect("seeds the call with persona, memory, assignments and recent messages", () => {
    const recorded: Array<RecordedKernelCall> = [];
    const messages: ReadonlyArray<AdeVoiceTranscriptMessage> = [
      { role: "system", text: "system noise", streaming: false },
      { role: "user", text: "ship the release", streaming: false },
      { role: "assistant", text: "on it", streaming: false },
      { role: "assistant", text: "half-written", streaming: true },
    ];
    return Effect.gen(function* () {
      const { channel, memory, botId } = yield* setup;
      yield* memory.writeMemory({
        botId,
        content: "Captain prefers jj over git.",
        author: "captain",
      });

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-5"),
        captainChannel: true,
      });

      const [context, ...window] = call.initialItems;
      assert.isDefined(context);
      assert.strictEqual(context?.role, "developer");
      // Component 1 (persona), component 2 (memory), and the fence around
      // bot-authored content all come from the shared projection renderer.
      assert.include(context?.text ?? "", "You are the Firstmate");
      assert.include(context?.text ?? "", "## Your memory");
      assert.include(context?.text ?? "", "Captain prefers jj over git.");
      assert.include(context?.text ?? "", UNTRUSTED_CONTENT_OPEN);

      // The bounded recent-messages window: streaming and system items drop.
      assert.deepStrictEqual(window, [
        { role: "user", text: "ship the release" },
        { role: "assistant", text: "on it" },
      ]);

      // The five-tool base catalog, verbatim from the shared gate, plus the
      // two captain-only approval tools.
      assert.deepStrictEqual(
        call.tools.map((tool) => tool.name),
        [
          "fleet_read",
          "create_assignment",
          "steer_primary",
          "report_assignment_result",
          "update_memory",
          ADE_VOICE_PREPARE_APPROVAL_TOOL,
          ADE_VOICE_COMMIT_APPROVAL_TOOL,
        ],
      );
      assert.deepStrictEqual(call.tools.slice(-2), [...ADE_VOICE_CAPTAIN_APPROVAL_TOOLS]);
    }).pipe(Effect.provide(makeLayer({ recorded, messages })));
  });

  it.effect("keeps the projection identical to the shared renderer", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-6"),
      });
      const projection = yield* rollover.projectSessionContext(botId);
      assert.isNull(projection.outgoingSessionSummary);
      assert.include(call.initialItems[0]?.text ?? "", renderSessionProjection(projection));
      assert.strictEqual(call.personaVersionId, projection.personaVersionId);
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("queues the end-of-call summary into the primary session and never steers", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, rollover, memory, botId } = yield* setup;
      yield* startPrimary(rollover, botId);

      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-7"),
      });
      const ended = yield* channel.endCall({
        bindingId: call.bindingId,
        summary: "Agreed to cut the release on Friday.",
        memoryUpdate: "Release cadence: Fridays.",
      });

      assert.deepStrictEqual(ended.delivery, {
        _tag: "queued",
        deliveryKey: `ade-voice-summary:${call.bindingId}`,
      });
      assert.isTrue(ended.memoryUpdated);

      // The port call shape is the assertion: exactly one deliverResults,
      // zero steers. A voice summary must never fold into a running turn.
      assert.deepStrictEqual(
        recorded.map((entry) => entry.operation),
        ["deliverResults"],
      );
      const batch = recorded[0]?.batch;
      assert.isDefined(batch);
      assert.strictEqual(batch?.targetBotId, botId);
      assert.strictEqual(batch?.engine, "shuvcode");
      assert.strictEqual(batch?.sessionId, KernelSessionId.make("primary-session-1"));
      assert.strictEqual(batch?.origin, "voice-call-summary");
      assert.strictEqual(batch?.redelivery, false);
      assert.deepStrictEqual(batch?.items, []);
      assert.isNull(batch?.parentAssignmentId ?? null);
      assert.include(batch?.text ?? "", "Agreed to cut the release on Friday.");
      // The spoken summary is bot-authored: it lands fenced.
      assert.include(batch?.text ?? "", UNTRUSTED_CONTENT_OPEN);

      assert.strictEqual((yield* memory.readMemory(botId)).content, "Release cadence: Fridays.");

      // The voice binding is retired with its summary; the primary is untouched.
      const bindings = yield* rollover.listBindings(botId);
      const voice = bindings.filter((binding) => binding.purpose === "voice");
      assert.lengthOf(voice, 1);
      assert.strictEqual(voice[0]?.status, "historical");
      assert.strictEqual(voice[0]?.rolloverSummary, "Agreed to cut the release on Friday.");
      assert.strictEqual(
        bindings.find((binding) => binding.purpose === "primary-text")?.status,
        "active",
      );

      // The call is gone: a late tool call has nothing to run under.
      const orphaned = yield* Effect.flip(
        channel.dispatchTool({ bindingId: call.bindingId, tool: "fleet_read", input: {} }),
      );
      assert.strictEqual(orphaned._tag, "AdeVoiceCallNotFoundError");
      yield* sql`SELECT 1`;
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("leaves exactly one live voice binding after a drop and redial", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;

      const dropped = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-8a"),
      });
      // The transport died without an end-of-call; the captain calls back.
      const redialed = yield* channel.redial({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-8b"),
      });
      assert.notStrictEqual(redialed.bindingId, dropped.bindingId);

      const voice = (yield* rollover.listBindings(botId)).filter(
        (binding) => binding.purpose === "voice",
      );
      assert.lengthOf(voice, 2);
      assert.deepStrictEqual(
        voice.map((binding) => binding.status),
        ["lost", "active"],
      );
      assert.strictEqual(voice.filter((binding) => binding.status === "active").length, 1);
      assert.strictEqual(voice[1]?.id, redialed.bindingId);

      // Only the fresh call is live in memory, too.
      assert.strictEqual((yield* channel.activeCall(botId))?.bindingId, redialed.bindingId);
      const orphaned = yield* Effect.flip(
        channel.dispatchTool({ bindingId: dropped.bindingId, tool: "fleet_read", input: {} }),
      );
      assert.strictEqual(orphaned._tag, "AdeVoiceCallNotFoundError");
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("drops the previous call's approval token on redial", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-9", refs: [{ _tag: "bot", botId }] });

      const dropped = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-9a"),
        captainChannel: true,
      });
      const prepared = yield* channel.prepareApproval({
        bindingId: dropped.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-9"),
      });

      const redialed = yield* channel.redial({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-9b"),
        captainChannel: true,
      });

      // The restatement was spoken on a call that no longer exists; the
      // captain never confirmed on this one.
      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: redialed.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-9"),
          token: prepared.token,
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "unknown-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-9"), "open");
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("runs base-catalog tools under the call's own bot authority", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { channel, botId } = yield* setup;
      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-10"),
      });

      // The fail-closed gate is wired here, so the observable fact is that the
      // call reaches the shared gate at all (and gets its typed denial back)
      // rather than owning a forked voice-only implementation.
      const outcome = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: "fleet_read",
        input: {},
      });
      assert.deepStrictEqual(outcome, {
        _tag: "denied",
        denial: { _tag: "not-yet-available", tool: "fleet_read" },
      });

      // A name the catalog does not carry is unknown, not smuggled through.
      const unknown = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: "thread_send",
        input: {},
      });
      assert.deepStrictEqual(unknown, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: "thread_send" },
      });
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });
});

describe("AdeVoiceChannel summary bounds", () => {
  it.effect("refuses an over-long end-of-call summary", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-11"),
      });
      const error = yield* Effect.flip(
        channel.endCall({ bindingId: call.bindingId, summary: "x".repeat(16_385) }),
      );
      assert.strictEqual(error._tag, "AdeVoiceSummaryLimitExceededError");
      assert.lengthOf(recorded, 0);
      // The call survives a refused end so the summary can be retried shorter.
      assert.strictEqual((yield* channel.activeCall(botId))?.bindingId, call.bindingId);
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });

  it.effect("reports no-primary-session instead of inventing a delivery target", () => {
    const recorded: Array<RecordedKernelCall> = [];
    return Effect.gen(function* () {
      const { channel, botId } = yield* setup;
      const call = yield* channel.openCall({
        botId,
        engine: "codex",
        sessionId: KernelSessionId.make("voice-session-12"),
      });
      const ended = yield* channel.endCall({
        bindingId: call.bindingId,
        summary: "Nothing to hand over.",
      });
      assert.deepStrictEqual(ended.delivery, { _tag: "no-primary-session" });
      assert.lengthOf(recorded, 0);
    }).pipe(Effect.provide(makeLayer({ recorded })));
  });
});
