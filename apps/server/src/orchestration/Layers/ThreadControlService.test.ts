import { TurnId } from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  boundedUntrustedThreadContext,
  validateInterruptTargetPrecondition,
  validateSendTargetPrecondition,
} from "./ThreadControlService.ts";
import { completeClaimedMutationDispatch } from "../Services/ThreadControlExecutionCoordinator.ts";
import { ThreadControlError } from "../Services/ThreadControlService.ts";

const failureCode = <A>(effect: Effect.Effect<A, { readonly code: string }>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return null;
      const failure = Cause.squash(exit.cause);
      return typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        typeof failure.code === "string"
        ? failure.code
        : null;
    }),
  );

describe("ThreadControlService exact target preconditions", () => {
  it.effect("distinguishes idle starts from exact-turn steering", () =>
    Effect.gen(function* () {
      const liveTurn = TurnId.make("turn-live");
      assert.strictEqual(
        yield* failureCode(
          validateSendTargetPrecondition({
            disposition: "start",
            expectedTurnId: null,
            currentTurnId: liveTurn,
            targetRuntimeMode: "approval-required",
            runtimeCeiling: "approval-required",
          }),
        ),
        "expected_idle",
      );
      assert.strictEqual(
        yield* failureCode(
          validateSendTargetPrecondition({
            disposition: "steer",
            expectedTurnId: TurnId.make("turn-stale"),
            currentTurnId: liveTurn,
            targetRuntimeMode: "approval-required",
            runtimeCeiling: "approval-required",
          }),
        ),
        "stale_target",
      );
      yield* validateSendTargetPrecondition({
        disposition: "start",
        expectedTurnId: null,
        currentTurnId: null,
        targetRuntimeMode: "approval-required",
        runtimeCeiling: "approval-required",
      });
      yield* validateSendTargetPrecondition({
        disposition: "steer",
        expectedTurnId: liveTurn,
        currentTurnId: liveTurn,
        targetRuntimeMode: "approval-required",
        runtimeCeiling: "approval-required",
      });
    }),
  );

  it.effect(
    "requires the exact active turn for interruption and enforces the runtime ceiling",
    () =>
      Effect.gen(function* () {
        const expected = TurnId.make("turn-expected");
        assert.strictEqual(
          yield* failureCode(
            validateInterruptTargetPrecondition({
              expectedTurnId: expected,
              currentTurnId: null,
            }),
          ),
          "already_terminal",
        );
        assert.strictEqual(
          yield* failureCode(
            validateInterruptTargetPrecondition({
              expectedTurnId: expected,
              currentTurnId: TurnId.make("turn-other"),
            }),
          ),
          "stale_target",
        );
        assert.strictEqual(
          yield* failureCode(
            validateSendTargetPrecondition({
              disposition: "start",
              expectedTurnId: null,
              currentTurnId: null,
              targetRuntimeMode: "full-access",
              runtimeCeiling: "approval-required",
            }),
          ),
          "runtime_ceiling_exceeded",
        );
        yield* validateInterruptTargetPrecondition({
          expectedTurnId: expected,
          currentTurnId: expected,
        });
      }),
  );
});

describe("ThreadControlService local mutation outbox", () => {
  const dispatchFailure = () =>
    new ThreadControlError({
      code: "dispatch_failed",
      message: "simulated crash boundary",
    });

  it.effect("retries safely after a crash between create and start intents", () =>
    Effect.gen(function* () {
      const durableReceipts = new Set<string>();
      const physicalAppends: Array<string> = [];
      let failBetweenIntents = true;
      let released = 0;
      const releaseIntentFlags: Array<boolean> = [];
      let marked = 0;

      const dispatchIntents = () =>
        Effect.gen(function* () {
          if (!durableReceipts.has("create")) {
            durableReceipts.add("create");
            physicalAppends.push("create");
          }
          if (failBetweenIntents) {
            failBetweenIntents = false;
            return yield* dispatchFailure();
          }
          if (!durableReceipts.has("start")) {
            durableReceipts.add("start");
            physicalAppends.push("start");
          }
          return "accepted";
        });
      const run = () =>
        completeClaimedMutationDispatch({
          dispatchIntents: dispatchIntents(),
          markDispatched: () =>
            Effect.sync(() => {
              marked += 1;
              return true;
            }),
          releaseClaim: (mayHavePersistedIntents) =>
            Effect.sync(() => {
              released += 1;
              releaseIntentFlags.push(mayHavePersistedIntents);
            }),
          reconcileOutcome: () => Effect.void,
        });

      yield* run().pipe(Effect.flip);
      assert.deepStrictEqual(physicalAppends, ["create"]);
      assert.strictEqual(released, 1);
      assert.deepStrictEqual(releaseIntentFlags, [true]);
      assert.strictEqual(marked, 0);

      assert.strictEqual(yield* run(), "accepted");
      assert.deepStrictEqual(physicalAppends, ["create", "start"]);
      assert.strictEqual(marked, 1);
    }),
  );

  it.effect("replays deterministic receipts after intents persist before dispatch marking", () =>
    Effect.gen(function* () {
      const durableReceipts = new Set<string>();
      const physicalAppends: Array<string> = [];
      let firstMark = true;
      let reconciled = 0;
      const releaseIntentFlags: Array<boolean> = [];

      const run = () =>
        completeClaimedMutationDispatch({
          dispatchIntents: Effect.sync(() => {
            for (const commandId of ["create", "start"]) {
              if (!durableReceipts.has(commandId)) {
                durableReceipts.add(commandId);
                physicalAppends.push(commandId);
              }
            }
            return "accepted";
          }),
          markDispatched: () =>
            firstMark
              ? Effect.sync(() => {
                  firstMark = false;
                }).pipe(Effect.andThen(Effect.fail(dispatchFailure())))
              : Effect.succeed(true),
          releaseClaim: (mayHavePersistedIntents) =>
            Effect.sync(() => {
              releaseIntentFlags.push(mayHavePersistedIntents);
            }),
          reconcileOutcome: () =>
            Effect.sync(() => {
              reconciled += 1;
            }),
        });

      yield* run().pipe(Effect.flip);
      assert.deepStrictEqual(physicalAppends, ["create", "start"]);
      assert.strictEqual(reconciled, 0);
      assert.deepStrictEqual(releaseIntentFlags, [true]);

      assert.strictEqual(yield* run(), "accepted");
      assert.deepStrictEqual(physicalAppends, ["create", "start"]);
      assert.strictEqual(reconciled, 1);
    }),
  );
});
