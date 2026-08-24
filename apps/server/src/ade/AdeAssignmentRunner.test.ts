import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  AdeBotChatSession,
  Assignment,
  BotId,
  OrchestrationCommand,
} from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeAssignmentRunner, renderAssignmentBrief } from "./AdeAssignmentRunner.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";

/** Tagged so the stub's failure stays distinguishable in the error channel. */
class StubDispatchError extends Schema.TaggedErrorClass<StubDispatchError>()(
  "StubDispatchError",
  {},
) {}

interface Spy {
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly chatted: Ref.Ref<ReadonlyArray<BotId>>;
  /** Set to make every `dispatch` fail, standing in for a kernel refusal. */
  readonly dispatchFails: Ref.Ref<boolean>;
}

/** Orchestration and chat are recorded, not simulated: this test is about
 * *which* work the runner picks and *what* it says, not about the kernel. */
const makeLayer = (spy: Spy) =>
  AdeAssignmentRunner.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdeAssignmentEngine.layer,
        Layer.succeed(AdeChatSessionPort, {
          startPrimaryChat: (botId: BotId) =>
            Ref.update(spy.chatted, (bots) => [...bots, botId]).pipe(
              Effect.as({
                botId,
                threadId: `ade-bot-${botId}` as AdeBotChatSession["threadId"],
                engine: "shuvcode",
                bindingId: "binding" as AdeBotChatSession["bindingId"],
                sessionId: "oc-1" as AdeBotChatSession["sessionId"],
                startedNow: true,
                toolsAttached: true,
              } satisfies AdeBotChatSession),
            ),
        }),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            Effect.flatMap(Ref.get(spy.dispatchFails), (fails) =>
              fails
                ? Effect.fail(new StubDispatchError())
                : Ref.update(spy.dispatched, (commands) => [...commands, command]).pipe(
                    Effect.as({ sequence: 1 }),
                  ),
            ),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
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
  yield* bootstrap.ensureSeeded();
  return {
    sql,
    bootstrap,
    engine: yield* AdeAssignmentEngine,
    runner: yield* AdeAssignmentRunner,
  };
});

type RunnerEnv = AdeAssignmentRunner | AdeAssignmentEngine | AdeBootstrap | SqlClient.SqlClient;

/** Runs `body` against a fresh in-memory fleet plus recording spies. */
const withRunner = <A, E>(body: (spy: Spy) => Effect.Effect<A, E, RunnerEnv>) =>
  Effect.gen(function* () {
    const spy: Spy = {
      dispatched: yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]),
      chatted: yield* Ref.make<ReadonlyArray<BotId>>([]),
      dispatchFails: yield* Ref.make(false),
    };
    return yield* Effect.provide(body(spy), makeLayer(spy));
  });

describe("renderAssignmentBrief", () => {
  it("names the assignment id and the reporting tool", () => {
    const assignment = {
      id: "assignment-1",
      instruction: "Rename the widget.",
      declaredRisk: "normal",
      projectId: null,
    } as unknown as Assignment;

    const brief = renderAssignmentBrief(assignment);
    // Without the id a bot cannot pass the S7 ownership inline check.
    assert.include(brief, "assignment-1");
    assert.include(brief, "report_assignment_result");
    assert.include(brief, "Rename the widget.");
  });
});

describe("AdeAssignmentRunner.runOnce", () => {
  it.effect("admits and briefs the queue head of an idle recipient", () =>
    withRunner((spy) =>
      Effect.gen(function* () {
        const { bootstrap, engine, runner } = yield* setup;
        const coder = yield* bootstrap.instantiateTemplate({
          templateId: "coder",
          projectId: null,
        });
        const first = yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "Do the first thing.",
          idempotencyKey: "one",
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "Do the second thing.",
          idempotencyKey: "two",
        });

        const started = yield* runner.runOnce();

        assert.deepEqual(
          started.map((assignment) => assignment.id),
          [first.assignment.id],
        );
        assert.equal(started[0]?.status, "running");
        // The recipient's session is warmed before it is briefed.
        assert.deepEqual(yield* Ref.get(spy.chatted), [coder.botId]);

        const commands = yield* Ref.get(spy.dispatched);
        assert.lengthOf(commands, 1);
        const command = commands[0];
        assert.equal(command?.type, "thread.turn.start");
        if (command?.type !== "thread.turn.start") return;
        assert.equal(command.threadId, `ade-bot-${coder.botId}`);
        assert.include(command.message.text, "Do the first thing.");
        assert.include(command.message.text, first.assignment.id);

        // FIFO, one at a time: the second stays queued while the first runs.
        const queued = yield* engine.listForBot(coder.botId, { statuses: ["queued"] });
        assert.lengthOf(queued, 1);
        assert.equal(queued[0]?.instruction, "Do the second thing.");
      }),
    ),
  );

  it.effect("leaves a recipient alone while it already has running work", () =>
    withRunner((spy) =>
      Effect.gen(function* () {
        const { bootstrap, engine, runner } = yield* setup;
        const coder = yield* bootstrap.instantiateTemplate({
          templateId: "coder",
          projectId: null,
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "First.",
          idempotencyKey: "one",
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "Second.",
          idempotencyKey: "two",
        });

        yield* runner.runOnce();
        const secondPass = yield* runner.runOnce();

        assert.lengthOf(secondPass, 0);
        assert.lengthOf(yield* Ref.get(spy.dispatched), 1);
      }),
    ),
  );

  it.effect("is a no-op when nothing is queued", () =>
    withRunner((spy) =>
      Effect.gen(function* () {
        const { runner } = yield* setup;
        assert.lengthOf(yield* runner.runOnce(), 0);
        assert.lengthOf(yield* Ref.get(spy.dispatched), 0);
      }),
    ),
  );

  it.effect("one recipient's failure does not stall the rest of the fleet", () =>
    withRunner(() =>
      Effect.gen(function* () {
        const { sql, bootstrap, engine, runner } = yield* setup;
        const good = yield* bootstrap.instantiateTemplate({
          templateId: "coder",
          projectId: null,
        });
        const gone = yield* bootstrap.instantiateTemplate({
          templateId: "reviewer",
          projectId: null,
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: good.botId,
          instruction: "Survivable.",
          idempotencyKey: "good",
        });
        const doomed = yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: gone.botId,
          instruction: "Recipient vanishes.",
          idempotencyKey: "gone",
        });
        // Delete the row out from under the runner so admission fails for
        // exactly one recipient mid-sweep.
        yield* sql`DELETE FROM ade_assignments WHERE assignment_id = ${doomed.assignment.id}`;

        const started = yield* runner.runOnce();
        assert.deepEqual(
          started.map((assignment) => assignment.recipientBotId),
          [good.botId],
        );
      }),
    ),
  );
  it.effect("leaves a bot blocked on an approval alone rather than briefing a second time", () =>
    withRunner((spy) =>
      Effect.gen(function* () {
        const { bootstrap, engine, runner } = yield* setup;
        const coder = yield* bootstrap.instantiateTemplate({
          templateId: "coder",
          projectId: null,
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "First.",
          idempotencyKey: "one",
        });
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "Second.",
          idempotencyKey: "two",
        });

        const started = yield* runner.runOnce();
        const first = started[0];
        assert.isDefined(first);
        if (first === undefined) return;

        // The bot parks on a captain approval. It still owns its one primary
        // session, so the queue must stay put.
        yield* engine.blockAssignment(first.id, "approval");

        const secondPass = yield* runner.runOnce();
        assert.lengthOf(secondPass, 0);
        assert.lengthOf(yield* Ref.get(spy.dispatched), 1);

        const queued = yield* engine.listForBot(coder.botId, { statuses: ["queued"] });
        assert.lengthOf(queued, 1);
      }),
    ),
  );

  it.effect("returns an assignment to the queue when its brief never reaches the kernel", () =>
    withRunner((spy) =>
      Effect.gen(function* () {
        const { bootstrap, engine, runner } = yield* setup;
        const coder = yield* bootstrap.instantiateTemplate({
          templateId: "coder",
          projectId: null,
        });
        const created = yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: coder.botId,
          instruction: "Only.",
          idempotencyKey: "one",
        });

        yield* Ref.set(spy.dispatchFails, true);
        const failedPass = yield* runner.runOnce();
        assert.lengthOf(failedPass, 0);
        assert.lengthOf(yield* Ref.get(spy.dispatched), 0);

        // Admission was undone: the row is queued again, so the bot reads as
        // idle and the next sweep retries it instead of stranding it running.
        const queued = yield* engine.listForBot(coder.botId, { statuses: ["queued"] });
        assert.deepEqual(
          queued.map((assignment) => assignment.id),
          [created.assignment.id],
        );

        yield* Ref.set(spy.dispatchFails, false);
        const retried = yield* runner.runOnce();
        assert.deepEqual(
          retried.map((assignment) => assignment.id),
          [created.assignment.id],
        );
        assert.lengthOf(yield* Ref.get(spy.dispatched), 1);
      }),
    ),
  );
});
