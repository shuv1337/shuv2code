import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  KernelSessionId,
  NeedsYouItemId,
  ThreadId,
  type AdeBotChatSession,
  type BotId,
  type IntegrationCandidateId,
  type NeedsYouSubjectRef,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { AdeApprovalPort } from "./AdeApprovalPort.ts";
import {
  AdeAssignmentEngine,
  AdeAssignmentKernelPort,
  adeAssignmentKernelPortUnwired,
  type AdeAssignmentDeliveryBatch,
} from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeScreenboxRuntime } from "./AdeScreenbox.ts";
import { AdeScreenboxClient, AdeScreenboxConfig } from "./AdeScreenboxClient.ts";
import {
  AdeSessionRollover,
  UNTRUSTED_CONTENT_OPEN,
  renderSessionProjection,
} from "./AdeSessionRollover.ts";
import { AdeToolGate } from "./AdeToolGate.ts";
import {
  ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS,
  ADE_VOICE_CAPTAIN_APPROVAL_TOOLS,
  ADE_VOICE_COMMIT_APPROVAL_TOOL,
  ADE_VOICE_PREPARE_APPROVAL_TOOL,
  ADE_VOICE_SUMMARY_MAX_DELIVERY_ATTEMPTS,
  AdeVoiceChannel,
  AdeVoicePrimaryTranscript,
  type AdeVoiceApprovalTokenRejectedError,
  type AdeVoiceTranscriptMessage,
} from "./AdeVoiceChannel.ts";
import {
  AdeVoiceApprovalPortLayerLive,
  AdeVoiceSummaryEscalationPortLayerLive,
  undeliveredVoiceSummaryItemId,
} from "./AdeVoiceChannelPortsLive.ts";

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

/** Every verdict the captain API forwarded to the integration service. */
interface RecordedVerdict {
  readonly candidateId: IntegrationCandidateId;
  readonly decision: "approve" | "deny";
}

const CONTROLLER_THREAD = ThreadId.make("voice-controller:test");

/** Unprovisioned Screenbox: builds, never reachable. */
const screenboxLayer = AdeScreenboxRuntime.layer.pipe(
  Layer.provide(AdeScreenboxClient.layer),
  Layer.provide(AdeScreenboxConfig.layer({ baseUrl: null, adminToken: "admin-token" })),
  Layer.provide(FetchHttpClient.layer),
);

class StubWorkspacePathError extends Schema.TaggedErrorClass<StubWorkspacePathError>()(
  "StubWorkspacePathError",
  { message: Schema.String },
) {}

const chatPortOk = Layer.succeed(AdeChatSessionPort, {
  startPrimaryChat: (botId: BotId) =>
    Effect.succeed({
      botId,
      threadId: "ade-bot-x" as AdeBotChatSession["threadId"],
      engine: "shuvcode",
      bindingId: "binding" as AdeBotChatSession["bindingId"],
      sessionId: "oc-1" as AdeBotChatSession["sessionId"],
      startedNow: true,
      toolsProbe: "attached",
      toolsAttached: true,
      modelHealth: "ok" as const,
      modelSlug: null,
    } satisfies AdeBotChatSession),
});

interface Harness {
  readonly recorded: Array<RecordedKernelCall>;
  readonly verdicts: Array<RecordedVerdict>;
  readonly messages?: ReadonlyArray<AdeVoiceTranscriptMessage>;
  /** Refuse every delivery, the way a down kernel does. */
  readonly kernelDown?: { current: boolean };
}

/**
 * The real captain API sits under the voice channel here on purpose: the whole
 * point of the approval path is that voice does not own it, so a fake in that
 * slot would test nothing. Only the *integration service* is stubbed, at the
 * same seam the inbox stubs it.
 */
const makeLayer = (harness: Harness) => {
  const kernelDown = harness.kernelDown ?? { current: false };
  const kernelPort = Layer.succeed(AdeAssignmentKernelPort, {
    ...adeAssignmentKernelPortUnwired,
    deliverResults: (batch: AdeAssignmentDeliveryBatch) =>
      kernelDown.current
        ? Effect.fail(
            new (class extends Error {
              readonly _tag = "AdeAssignmentKernelPortError";
              readonly operation = "deliverResults";
              readonly detail = "the shuvcode adapter is not routable";
            })() as never,
          )
        : Effect.sync(() => {
            harness.recorded.push({ operation: "deliverResults", batch });
          }),
    steerPrimary: (steer: { readonly text: string }) =>
      Effect.sync(() => {
        harness.recorded.push({ operation: "steerPrimary", steerText: steer.text });
      }),
  });
  const approvalPort = Layer.succeed(AdeApprovalPort, {
    submitIntegrationApproval: (input: {
      readonly candidateId: IntegrationCandidateId;
      readonly decision: "approve" | "deny";
    }) =>
      Effect.sync(() => {
        harness.verdicts.push({ candidateId: input.candidateId, decision: input.decision });
      }),
    readCandidateStatus: () => Effect.succeed("awaiting-approval" as string | null),
  });
  const transcript = Layer.succeed(AdeVoicePrimaryTranscript, {
    recentMessages: () => Effect.succeed(harness.messages ?? []),
  });

  return AdeVoiceChannel.layer.pipe(
    Layer.provide(kernelPort),
    Layer.provide(transcript),
    Layer.provide(AdeToolGate.layerFailClosed),
    Layer.provideMerge(AdeVoiceApprovalPortLayerLive),
    Layer.provideMerge(AdeVoiceSummaryEscalationPortLayerLive),
    Layer.provideMerge(AdeCaptainApi.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdePersonaMemory.layer,
        AdeSessionRollover.layer,
        AdeAssignmentEngine.layer,
        // S15 gave the captain API a Screenbox dependency. Voice never touches
        // it, so it is wired unprovisioned (`baseUrl: null`) — present enough
        // to build the real captain API, inert enough that a voice test cannot
        // accidentally depend on a desktop runtime.
        screenboxLayer,
        chatPortOk,
        approvalPort,
        Layer.succeed(WorkspacePaths, {
          normalizeWorkspaceRoot: () =>
            Effect.fail(new StubWorkspacePathError({ message: "not used" })),
        } as unknown as WorkspacePaths["Service"]),
      ),
    ),
    Layer.provide(kernelPort),
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
    captain: yield* AdeCaptainApi,
    botId: seeded.firstmateBotId,
  };
});

/**
 * An open `approval` item exactly as the integration service files one: it
 * names the candidate the verdict will be forwarded to.
 */
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

const seedItem = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly kind: string;
    readonly refs: ReadonlyArray<NeedsYouSubjectRef>;
  },
) =>
  sql`
    INSERT INTO ade_needs_you_items (
      needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
    ) VALUES (
      ${input.id}, ${input.kind}, ${JSON.stringify(input.refs)}, 'open',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;

const CANDIDATE = "candidate-1" as IntegrationCandidateId;
const approvalRefs = (botId: BotId): ReadonlyArray<NeedsYouSubjectRef> => [
  { _tag: "bot", botId },
  { _tag: "integrationCandidate", integrationCandidateId: CANDIDATE },
];

const needsYouStatus = (sql: SqlClient.SqlClient, id: string) =>
  Effect.map(
    sql<{ status: string }>`
      SELECT status FROM ade_needs_you_items WHERE needs_you_item_id = ${id}
    `,
    (rows) => rows[0]?.status ?? null,
  );

const startPrimary = (rollover: AdeSessionRollover["Service"], botId: BotId) =>
  rollover.startPrimarySession({
    botId,
    engine: "shuvcode",
    sessionId: KernelSessionId.make("primary-session-1"),
  });

const openCaptainCall = (
  channel: AdeVoiceChannel["Service"],
  botId: BotId,
  sessionId: string,
  captainChannel = true,
) =>
  channel.openCall({
    botId,
    engine: "codex",
    sessionId: KernelSessionId.make(sessionId),
    controllerThreadId: CONTROLLER_THREAD,
    captainChannel,
  });

const harness = (): Harness => ({ recorded: [], verdicts: [] });

// ---------------------------------------------------------------------------

describe("AdeVoiceChannel two-phase verbal approvals", () => {
  it.effect("refuses a commit with no prepared token — nothing is approved", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-1", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-1");

      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-1"),
          token: "definitely-not-a-real-token",
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "unknown-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-1"), "open");
      assert.lengthOf(h.verdicts, 0);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("refuses a commit once the confirmation token has expired", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-2", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-2");

      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-2"),
        decision: "approve",
      });
      // Phase 1 decides nothing.
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-2"), "open");
      assert.lengthOf(h.verdicts, 0);
      assert.include(prepared.restatement, "waiting for your approval");
      assert.include(prepared.restatement, "I am about to approve this");

      yield* TestClock.adjust(Duration.millis(ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS));

      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-2"),
          token: prepared.token,
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "expired-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-2"), "open");
      assert.lengthOf(h.verdicts, 0);
    }).pipe(Effect.provide(makeLayer(h)), Effect.provide(TestClock.layer()));
  });

  it.effect("commits through the captain decision path, and the token is single-use", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-3", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-3");
      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-3"),
        decision: "approve",
      });

      yield* TestClock.adjust(Duration.millis(ADE_VOICE_APPROVAL_TOKEN_TTL_MILLIS - 1));
      const committed = yield* channel.commitApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-3"),
        token: prepared.token,
        decision: "approve",
      });
      assert.strictEqual(committed.decision, "approve");
      assert.strictEqual(committed.entry.item.status, "resolved");

      // The verdict reached the service parked on the item — the half that a
      // bare status write would have silently skipped.
      assert.deepStrictEqual(h.verdicts, [{ candidateId: CANDIDATE, decision: "approve" }]);
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-3"), "resolved");

      const replay = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-3"),
          token: prepared.token,
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(replay).reason, "unknown-token");
      assert.lengthOf(h.verdicts, 1);
    }).pipe(Effect.provide(makeLayer(h)), Effect.provide(TestClock.layer()));
  });

  it.effect("denies through the real deny path rather than inventing a status", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-deny", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-deny");
      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-deny"),
        decision: "deny",
      });
      assert.include(prepared.restatement, "I am about to deny this");

      yield* channel.commitApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-deny"),
        token: prepared.token,
        decision: "deny",
      });

      // A denial bounces the change back for repair; it is emphatically not a
      // 'dismissed' row nothing else produces.
      assert.deepStrictEqual(h.verdicts, [{ candidateId: CANDIDATE, decision: "deny" }]);
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-deny"), "resolved");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("refuses a commit whose decision is not the one that was restated", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-flip", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-flip");
      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-flip"),
        decision: "deny",
      });

      // The model read "I am about to deny this" aloud and then tried to
      // approve. The one field carrying the captain's answer disagrees.
      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-flip"),
          token: prepared.token,
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "wrong-decision");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-flip"), "open");
      assert.lengthOf(h.verdicts, 0);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("refuses to verbally approve items that carry no approve/deny decision", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedItem(sql, {
        id: "kernel-down-1",
        kind: "kernel-down",
        refs: [{ _tag: "kernel", engine: "shuvcode" }],
      });
      yield* seedItem(sql, {
        id: "stall-1",
        kind: "stall",
        refs: [
          { _tag: "bot", botId },
          { _tag: "assignment", assignmentId: "a-1" as never },
        ],
      });
      yield* seedItem(sql, {
        id: "unroutable-1",
        kind: "stall",
        refs: [{ _tag: "integrationCandidate", integrationCandidateId: CANDIDATE }],
      });
      const call = yield* openCaptainCall(channel, botId, "voice-session-shape");

      for (const id of ["kernel-down-1", "stall-1", "unroutable-1"]) {
        const refused = yield* Effect.flip(
          channel.prepareApproval({
            bindingId: call.bindingId,
            needsYouItemId: NeedsYouItemId.make(id),
            decision: "approve",
          }),
        );
        assert.strictEqual(refused._tag, "AdeVoiceApprovalSubjectUnavailableError");
        // Nothing is retired by a refusal — these clear on their own.
        assert.strictEqual(yield* needsYouStatus(sql, id), "open");
      }
      assert.lengthOf(h.verdicts, 0);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("refuses an approval whose subject did not survive decoding", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      // An approval item with no candidate ref: the verdict would have nowhere
      // to go, so it must not be speakable.
      yield* seedApprovalItem(sql, { id: "needs-you-blind", refs: [{ _tag: "bot", botId }] });
      const call = yield* openCaptainCall(channel, botId, "voice-session-blind");

      const refused = yield* Effect.flip(
        channel.prepareApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-blind"),
          decision: "approve",
        }),
      );
      assert.strictEqual(refused._tag, "AdeVoiceApprovalSubjectUnavailableError");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-blind"), "open");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("supersedes an earlier token when the same item is prepared again", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-again", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-again");

      const first = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-again"),
        decision: "approve",
      });
      const second = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-again"),
        decision: "deny",
      });
      assert.notStrictEqual(first.token, second.token);

      // The sentence the captain heard first is stale; its token dies with it.
      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-again"),
          token: first.token,
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "unknown-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-again"), "open");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("keeps the approval tools off a non-captain call", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-4", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-4", false);

      const names = call.tools.map((tool) => tool.name);
      assert.notInclude(names, ADE_VOICE_PREPARE_APPROVAL_TOOL);
      assert.notInclude(names, ADE_VOICE_COMMIT_APPROVAL_TOOL);

      const outcome = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: ADE_VOICE_PREPARE_APPROVAL_TOOL,
        input: { needsYouId: "needs-you-4", decision: "approve" },
      });
      assert.deepStrictEqual(outcome, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: ADE_VOICE_PREPARE_APPROVAL_TOOL },
      });

      const refused = yield* Effect.flip(
        channel.prepareApproval({
          bindingId: call.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-4"),
          decision: "approve",
        }),
      );
      assert.strictEqual(refused._tag, "AdeVoiceApprovalNotPermittedError");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-4"), "open");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("refuses a commit tool call that omits the decision", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-nodec", refs: approvalRefs(botId) });
      const call = yield* openCaptainCall(channel, botId, "voice-session-nodec");
      const prepared = yield* channel.prepareApproval({
        bindingId: call.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-nodec"),
        decision: "approve",
      });

      const outcome = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: ADE_VOICE_COMMIT_APPROVAL_TOOL,
        input: { needsYouId: "needs-you-nodec", token: prepared.token },
      });
      assert.strictEqual(outcome._tag, "denied");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-nodec"), "open");
      assert.lengthOf(h.verdicts, 0);
    }).pipe(Effect.provide(makeLayer(h)));
  });
});

describe("AdeVoiceChannel call surface", () => {
  it.effect("seeds the call with persona, memory, assignments and recent messages", () => {
    const h: Harness = {
      ...harness(),
      messages: [
        { role: "system", text: "system noise", streaming: false },
        { role: "user", text: "ship the release", streaming: false },
        { role: "assistant", text: "on it", streaming: false },
        { role: "assistant", text: "half-written", streaming: true },
      ],
    };
    return Effect.gen(function* () {
      const { channel, memory, botId } = yield* setup;
      yield* memory.writeMemory({
        botId,
        content: "Captain prefers jj over git.",
        author: "captain",
      });

      const call = yield* openCaptainCall(channel, botId, "voice-session-5");

      const [context, ...window] = call.initialItems;
      assert.strictEqual(context?.role, "developer");
      assert.include(context?.text ?? "", "You are the Firstmate");
      assert.include(context?.text ?? "", "## Your memory");
      assert.include(context?.text ?? "", "Captain prefers jj over git.");
      assert.include(context?.text ?? "", UNTRUSTED_CONTENT_OPEN);

      assert.deepStrictEqual(window, [
        { role: "user", text: "ship the release" },
        { role: "assistant", text: "on it" },
      ]);

      assert.deepStrictEqual(
        call.tools.map((tool) => tool.name),
        [
          "fleet_read",
          "create_assignment",
          "steer_primary",
          "report_assignment_result",
          "update_memory",
          "create_bot",
          ADE_VOICE_PREPARE_APPROVAL_TOOL,
          ADE_VOICE_COMMIT_APPROVAL_TOOL,
        ],
      );
      assert.deepStrictEqual(call.tools.slice(-2), [...ADE_VOICE_CAPTAIN_APPROVAL_TOOLS]);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("keeps the projection identical to the shared renderer", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      const call = yield* openCaptainCall(channel, botId, "voice-session-6", false);
      const projection = yield* rollover.projectSessionContext(botId);
      assert.isNull(projection.outgoingSessionSummary);
      assert.include(call.initialItems[0]?.text ?? "", renderSessionProjection(projection));
      assert.strictEqual(call.personaVersionId, projection.personaVersionId);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("finds the live call by its controller thread, and only while it is live", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      assert.isNull(yield* channel.callByControllerThread(CONTROLLER_THREAD));

      const call = yield* openCaptainCall(channel, botId, "voice-session-lookup");
      assert.strictEqual(
        (yield* channel.callByControllerThread(CONTROLLER_THREAD))?.bindingId,
        call.bindingId,
      );
      // Any other controller thread is not an ADE call and must stay classic.
      assert.isNull(yield* channel.callByControllerThread(ThreadId.make("someone-elses-thread")));

      yield* channel.endCall({ bindingId: call.bindingId, summary: "done" });
      assert.isNull(yield* channel.callByControllerThread(CONTROLLER_THREAD));
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("queues the end-of-call summary into the primary session and never steers", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, memory, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      const call = yield* openCaptainCall(channel, botId, "voice-session-7", false);
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

      assert.deepStrictEqual(
        h.recorded.map((entry) => entry.operation),
        ["deliverResults"],
      );
      const batch = h.recorded[0]?.batch;
      assert.strictEqual(batch?.targetBotId, botId);
      assert.strictEqual(batch?.engine, "shuvcode");
      assert.strictEqual(batch?.sessionId, KernelSessionId.make("primary-session-1"));
      assert.strictEqual(batch?.origin, "voice-call-summary");
      assert.deepStrictEqual(batch?.items, []);
      assert.include(batch?.text ?? "", "Agreed to cut the release on Friday.");
      assert.include(batch?.text ?? "", UNTRUSTED_CONTENT_OPEN);

      assert.strictEqual((yield* memory.readMemory(botId)).content, "Release cadence: Fridays.");

      const voice = (yield* rollover.listBindings(botId)).filter(
        (binding) => binding.purpose === "voice",
      );
      assert.lengthOf(voice, 1);
      assert.strictEqual(voice[0]?.status, "historical");
      assert.strictEqual(voice[0]?.rolloverSummary, "Agreed to cut the release on Friday.");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("leaves exactly one live voice binding after a drop and redial", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      const dropped = yield* openCaptainCall(channel, botId, "voice-session-8a", false);
      const redialed = yield* openCaptainCall(channel, botId, "voice-session-8b", false);
      assert.notStrictEqual(redialed.bindingId, dropped.bindingId);

      const voice = (yield* rollover.listBindings(botId)).filter(
        (binding) => binding.purpose === "voice",
      );
      assert.lengthOf(voice, 2);
      assert.deepStrictEqual(
        voice.map((binding) => binding.status),
        ["lost", "active"],
      );
      assert.strictEqual((yield* channel.activeCall(botId))?.bindingId, redialed.bindingId);
      const orphaned = yield* Effect.flip(
        channel.dispatchTool({ bindingId: dropped.bindingId, tool: "fleet_read", input: {} }),
      );
      assert.strictEqual(orphaned._tag, "AdeVoiceCallNotFoundError");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("survives two interleaved redials with one live voice binding", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      yield* openCaptainCall(channel, botId, "voice-session-race-0", false);

      // Both redials retire-then-open concurrently. Exactly one may end up
      // active; the loser adopts rather than stacking a second binding.
      const [first, second] = yield* Effect.all(
        [
          openCaptainCall(channel, botId, "voice-session-race-a", false),
          openCaptainCall(channel, botId, "voice-session-race-b", false),
        ],
        { concurrency: 2 },
      );

      const voice = (yield* rollover.listBindings(botId)).filter(
        (binding) => binding.purpose === "voice",
      );
      const live = voice.filter((binding) => binding.status === "active");
      assert.lengthOf(live, 1);
      // Whoever adopted, both callers point at a binding that is actually live.
      const liveId = live[0]?.id;
      assert.include([first.bindingId, second.bindingId], liveId);
      assert.strictEqual((yield* channel.activeCall(botId))?.bindingId, liveId);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("drops the previous call's approval token on redial", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { sql, channel, botId } = yield* setup;
      yield* seedApprovalItem(sql, { id: "needs-you-9", refs: approvalRefs(botId) });
      const dropped = yield* openCaptainCall(channel, botId, "voice-session-9a");
      const prepared = yield* channel.prepareApproval({
        bindingId: dropped.bindingId,
        needsYouItemId: NeedsYouItemId.make("needs-you-9"),
        decision: "approve",
      });
      const redialed = yield* openCaptainCall(channel, botId, "voice-session-9b");

      const rejected = yield* Effect.flip(
        channel.commitApproval({
          bindingId: redialed.bindingId,
          needsYouItemId: NeedsYouItemId.make("needs-you-9"),
          token: prepared.token,
          decision: "approve",
        }),
      );
      assert.strictEqual(expectTokenRejection(rejected).reason, "unknown-token");
      assert.strictEqual(yield* needsYouStatus(sql, "needs-you-9"), "open");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("runs base-catalog tools under the call's own bot authority", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, botId } = yield* setup;
      const call = yield* openCaptainCall(channel, botId, "voice-session-10", false);

      const outcome = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: "fleet_read",
        input: {},
      });
      assert.deepStrictEqual(outcome, {
        _tag: "denied",
        denial: { _tag: "not-yet-available", tool: "fleet_read" },
      });

      // The thread toolkit is gone on an ADE call, not merely unused.
      const unknown = yield* channel.dispatchTool({
        bindingId: call.bindingId,
        tool: "thread_send",
        input: {},
      });
      assert.deepStrictEqual(unknown, {
        _tag: "denied",
        denial: { _tag: "unknown-tool", tool: "thread_send" },
      });
    }).pipe(Effect.provide(makeLayer(h)));
  });
});

describe("AdeVoiceChannel summary durability", () => {
  it.effect("refuses an over-long end-of-call summary and keeps the call open", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      const call = yield* openCaptainCall(channel, botId, "voice-session-11", false);
      const error = yield* Effect.flip(
        channel.endCall({ bindingId: call.bindingId, summary: "x".repeat(16_385) }),
      );
      assert.strictEqual(error._tag, "AdeVoiceSummaryLimitExceededError");
      assert.lengthOf(h.recorded, 0);
      assert.strictEqual((yield* channel.activeCall(botId))?.bindingId, call.bindingId);
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("persists the summary before delivery, then retries it to success", () => {
    const kernelDown = { current: true };
    const h: Harness = { ...harness(), kernelDown };
    return Effect.gen(function* () {
      const { channel, rollover, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      const call = yield* openCaptainCall(channel, botId, "voice-session-retry", false);

      const ended = yield* channel.endCall({
        bindingId: call.bindingId,
        summary: "The kernel was down when we hung up.",
      });
      // Not a loss: the words are already on the binding row.
      assert.strictEqual(ended.delivery._tag, "retrying");
      const voice = (yield* rollover.listBindings(botId)).find(
        (binding) => binding.purpose === "voice",
      );
      assert.strictEqual(voice?.rolloverSummary, "The kernel was down when we hung up.");
      assert.lengthOf(h.recorded, 0);

      // Still down: the sweep keeps it queued rather than dropping it.
      assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
        delivered: 0,
        retrying: 1,
        escalated: 0,
      });

      kernelDown.current = false;
      assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
        delivered: 1,
        retrying: 0,
        escalated: 0,
      });
      assert.deepStrictEqual(
        h.recorded.map((entry) => entry.operation),
        ["deliverResults"],
      );
      assert.strictEqual(h.recorded[0]?.batch?.redelivery, true);
      assert.include(h.recorded[0]?.batch?.text ?? "", "The kernel was down when we hung up.");

      // Retry state is cleared: a later sweep does nothing.
      assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
        delivered: 0,
        retrying: 0,
        escalated: 0,
      });
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("files an acknowledgeable Needs You item once the retry budget runs out", () => {
    const kernelDown = { current: true };
    const h: Harness = { ...harness(), kernelDown };
    return Effect.gen(function* () {
      const { sql, channel, captain, rollover, botId } = yield* setup;
      yield* startPrimary(rollover, botId);
      const call = yield* openCaptainCall(channel, botId, "voice-session-lost", false);
      yield* channel.endCall({
        bindingId: call.bindingId,
        summary: "Nobody was listening.",
      });

      // endCall already burned attempt 1.
      for (let attempt = 1; attempt < ADE_VOICE_SUMMARY_MAX_DELIVERY_ATTEMPTS - 1; attempt += 1) {
        assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
          delivered: 0,
          retrying: 1,
          escalated: 0,
        });
      }
      assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
        delivered: 0,
        retrying: 0,
        escalated: 1,
      });

      const itemId = undeliveredVoiceSummaryItemId(call.bindingId);
      assert.strictEqual(yield* needsYouStatus(sql, itemId), "open");

      // The captain can actually clear it — an item nothing can retire is the
      // defect this escalation would otherwise reproduce.
      const entry = yield* captain.getNeedsYouItem(NeedsYouItemId.make(itemId));
      assert.strictEqual(entry.action, "acknowledge");
      assert.include(entry.title, "voice call summary could not be delivered");
      yield* captain.submitNeedsYouDecision({
        needsYouItemId: NeedsYouItemId.make(itemId),
        decision: "acknowledge",
      });
      assert.strictEqual(yield* needsYouStatus(sql, itemId), "resolved");

      // Deduped: a second exhaustion for the same binding cannot pile up.
      assert.deepStrictEqual(yield* channel.sweepPendingSummaries(), {
        delivered: 0,
        retrying: 0,
        escalated: 0,
      });
      assert.strictEqual(yield* needsYouStatus(sql, itemId), "resolved");
    }).pipe(Effect.provide(makeLayer(h)));
  });

  it.effect("reports no-primary-session instead of inventing a delivery target", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { channel, botId } = yield* setup;
      const call = yield* openCaptainCall(channel, botId, "voice-session-12", false);
      const ended = yield* channel.endCall({
        bindingId: call.bindingId,
        summary: "Nothing to hand over.",
      });
      // No primary session yet: still durable on the row, still swept.
      assert.strictEqual(ended.delivery._tag, "retrying");
      assert.lengthOf(h.recorded, 0);
    }).pipe(Effect.provide(makeLayer(h)));
  });
});
