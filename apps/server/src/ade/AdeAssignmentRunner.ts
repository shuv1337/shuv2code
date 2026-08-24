/**
 * ADE assignment runner (spec `docs/ade/ADE-V1-SPEC.md` §4.2; issue #163).
 *
 * S7's engine owns the *record* of an assignment — admission, FIFO position,
 * blocked states, exactly-once result delivery. It deliberately does not own
 * *execution*: `startAssignment` moves a row to `running`, but nothing tells
 * the recipient bot to actually do the work. This runner is that missing
 * half, and it is what turns S9's walking skeleton into a loop the captain can
 * watch: Firstmate delegates → the crew bot's session receives the brief →
 * the bot reports its result through the gate → the engine delivers it back
 * into Firstmate's session as synthetic input.
 *
 * Two deliberate narrownesses for V1:
 *
 * - **One in-flight assignment per bot.** Per-bot FIFO with no priority
 *   scheduler is the locked semantic (ADR §13); serving the queue head only
 *   while nothing is running keeps the bot's single primary session from
 *   receiving two briefs at once.
 * - **The brief is an ordinary turn, not synthetic input.** A crew bot's
 *   assignment should be visible in its own conversation — the captain can
 *   open the bot's chat and read exactly what it was asked to do. Synthetic
 *   input is reserved for what ADR §13 reserves it for: *results* flowing back
 *   to a requester who is already mid-conversation.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type Assignment,
  type BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
} from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { AdeAssignmentEngine } from "./AdeAssignmentEngine.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { adeBotThreadId } from "./AdeShuvcodeChatSession.ts";

/** How often the runner looks for queued work with an idle recipient. */
export const ADE_RUNNER_SWEEP_INTERVAL_DEFAULT = Duration.seconds(5);

/**
 * The brief a bot receives when its queued assignment is admitted. The
 * assignment id is stated explicitly because `report_assignment_result` is
 * ownership-checked against it by the S7 inline checks — a bot that cannot
 * name its assignment cannot report on it.
 */
export const renderAssignmentBrief = (assignment: Assignment): string =>
  [
    "You have been assigned work by the fleet.",
    "",
    `Assignment id: ${assignment.id}`,
    `Declared risk: ${assignment.declaredRisk}`,
    ...(assignment.projectId === null ? [] : [`Project: ${assignment.projectId}`]),
    "",
    "Instruction:",
    assignment.instruction,
    "",
    "When the work is finished — or if you cannot finish it — call the",
    "`report_assignment_result` tool with this assignment id, a terminal status,",
    "and a short summary. The result is delivered back to whoever requested it.",
  ].join("\n");

export interface AdeAssignmentRunnerShape {
  /** One pass: admit and brief the queue head of every idle recipient. */
  readonly runOnce: () => Effect.Effect<ReadonlyArray<Assignment>>;
}

export class AdeAssignmentRunner extends Context.Service<
  AdeAssignmentRunner,
  AdeAssignmentRunnerShape
>()("shuv2code/ade/AdeAssignmentRunner") {
  static readonly layer: Layer.Layer<
    AdeAssignmentRunner,
    never,
    | SqlClient.SqlClient
    | AdeAssignmentEngine
    | AdeChatSessionPort
    | OrchestrationEngine.OrchestrationEngineService
  > = Layer.effect(
    AdeAssignmentRunner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const engine = yield* AdeAssignmentEngine;
      const chat = yield* AdeChatSessionPort;
      const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;

      /**
       * Recipients with queued work and nothing else in flight. "In flight" is
       * `running` **or** `blocked`, not just `running`: a bot parked on an
       * approval, on its children, or on `needs-resume` still owns the
       * conversation in its one primary session, and briefing it again would
       * interleave a second assignment into work the captain has not unblocked
       * yet. Only terminal statuses free the bot.
       *
       * Both halves are one statement so a bot that just started something is
       * never selected by a stale read.
       */
      const idleRecipients = sql<{ recipient_bot_id: string }>`
        SELECT DISTINCT q.recipient_bot_id AS recipient_bot_id
        FROM ade_assignments q
        WHERE q.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM ade_assignments r
            WHERE r.recipient_bot_id = q.recipient_bot_id
              AND r.status IN ('running', 'blocked')
          )
      `;

      const briefOne = Effect.fn("AdeAssignmentRunner.briefOne")(function* (botId: BotId) {
        const next = yield* engine.nextQueued(botId);
        if (next === null) return null;

        // The recipient needs a live session before it can be briefed;
        // failure here leaves the assignment queued for the next sweep
        // rather than burning it.
        yield* chat.startPrimaryChat(botId);

        const outcome = yield* engine.startAssignment(next.id, { engine: "shuvcode" });
        if (outcome.blockedByKernel) return null;

        const createdAt = DateTime.formatIso(yield* DateTime.now);
        // From here the row is already `running`. If the brief never reaches
        // the kernel, nothing will ever re-send it — the recipient is not idle
        // any more, so the next sweep skips it, and the assignment sits
        // `running` with no work happening. Undo the admission instead, so the
        // queue head is retried on the next tick.
        yield* orchestration
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`ade-assignment:${next.id}:brief`),
            threadId: adeBotThreadId(botId),
            message: {
              messageId: MessageId.make(`ade-assignment:${next.id}:brief`),
              role: "user",
              text: renderAssignmentBrief(outcome.assignment),
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          })
          .pipe(
            Effect.tapError(() =>
              Effect.logWarning("ADE assignment brief dispatch failed; returning it to the queue", {
                assignmentId: next.id,
              }),
            ),
            Effect.onError(() => Effect.ignore(engine.releaseAssignment(next.id, "queued"))),
          );
        return outcome.assignment;
      });

      const runOnce: AdeAssignmentRunnerShape["runOnce"] = Effect.fn("AdeAssignmentRunner.runOnce")(
        function* () {
          const rows = yield* Effect.orElseSucceed(idleRecipients, () => []);
          const started: Array<Assignment> = [];
          for (const row of rows) {
            // One bot's failure must not stall the rest of the fleet.
            const admitted = yield* briefOne(row.recipient_bot_id as BotId).pipe(
              Effect.catch((cause) =>
                Effect.as(
                  Effect.logWarning("ADE assignment brief failed", {
                    botId: row.recipient_bot_id,
                    cause,
                  }),
                  null,
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.as(
                  Effect.logWarning("ADE assignment brief defected", {
                    botId: row.recipient_bot_id,
                    defect,
                  }),
                  null,
                ),
              ),
            );
            if (admitted !== null) started.push(admitted);
          }
          return started;
        },
      );

      return AdeAssignmentRunner.of({ runOnce });
    }),
  );

  /**
   * Background sweep, parked until server activation like the engine's
   * delivery sweeper and the S17 health ticker.
   */
  static readonly sweeperLive = (
    interval: Duration.Duration = ADE_RUNNER_SWEEP_INTERVAL_DEFAULT,
  ): Layer.Layer<never, never, AdeAssignmentRunner> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const runner = yield* AdeAssignmentRunner;
        yield* forkParked(
          Effect.repeat(
            Effect.catchDefect(runner.runOnce(), (defect) =>
              Effect.as(Effect.logWarning("ADE assignment sweep defected", { defect }), []),
            ),
            Schedule.spaced(interval),
          ),
        );
      }),
    );
}
