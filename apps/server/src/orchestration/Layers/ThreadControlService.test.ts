import { ModelSelection, type ProviderInstanceId, TurnId } from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  boundedUntrustedThreadContext,
  isAvailableThreadControlSource,
  resolveControllerCreateModelSelection,
  resolveUntrustedContextLimits,
  untrustedThreadContext,
  validateInterruptTargetPrecondition,
  validateSendTargetPrecondition,
} from "./ThreadControlService.ts";
import { completeClaimedMutationDispatch } from "../Services/ThreadControlExecutionCoordinator.ts";
import { ThreadControlError } from "../Services/ThreadControlService.ts";

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

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
  it("accepts ordinary durable threads as controller sources but never transport threads", () => {
    const available = { deletedAt: null, archivedAt: null };
    assert.isTrue(isAvailableThreadControlSource({ ...available, purpose: "standard" }));
    assert.isTrue(isAvailableThreadControlSource({ ...available, purpose: "voice-controller" }));
    assert.isFalse(isAvailableThreadControlSource({ ...available, purpose: "voice-transport" }));
    assert.isFalse(
      isAvailableThreadControlSource({
        purpose: "standard",
        deletedAt: "2026-08-16T00:00:00.000Z",
        archivedAt: null,
      }),
    );
  });

  it("bounds recent user and assistant context in chronological order", () => {
    const context = boundedUntrustedThreadContext([
      { role: "system", text: "hidden" },
      { role: "user", text: "first" },
      { role: "assistant", text: "draft", streaming: true },
      { role: "assistant", text: "second" },
      { role: "user", text: "x".repeat(5_000) },
    ]);

    assert.deepStrictEqual(context.slice(0, 2), [
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
    ]);
    assert.strictEqual(context[2]?.role, "user");
    assert.strictEqual(context[2]?.text.length, 4_000);
  });

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

describe("resolveControllerCreateModelSelection", () => {
  const instanceIdOf = (value: string) => value as ProviderInstanceId;
  const makeModel = (instanceId: string, model: string) =>
    decodeModelSelection({ instanceId, model });
  const invalidModelCode = (run: () => unknown): string | null => {
    try {
      run();
      return null;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : null;
    }
  };

  const candidates = [
    {
      instanceId: instanceIdOf("codex"),
      snapshot: {
        enabled: true,
        availability: "available" as const,
        models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.6-luna" }],
      },
    },
    {
      instanceId: instanceIdOf("broken"),
      snapshot: {
        enabled: false,
        availability: "available" as const,
        models: [{ slug: "gpt-5.6-sol" }],
      },
    },
  ];

  it("clones the controller model when no model is requested", () => {
    const controllerModel = makeModel("opencodeV2", "ox");
    assert.strictEqual(
      resolveControllerCreateModelSelection({
        requestedModel: undefined,
        controllerModel,
        candidates,
      }),
      controllerModel,
    );
  });

  it("clones the controller model when the requested model matches it", () => {
    const controllerModel = makeModel("opencodeV2", "ox");
    assert.strictEqual(
      resolveControllerCreateModelSelection({
        requestedModel: "ox",
        controllerModel,
        candidates,
      }),
      controllerModel,
    );
  });

  it("resolves a requested model against available instances", () => {
    const controllerModel = makeModel("opencodeV2", "ox");
    const selection = resolveControllerCreateModelSelection({
      requestedModel: "gpt-5.6-sol",
      controllerModel,
      candidates,
    });
    assert.strictEqual(selection.instanceId, "codex");
    assert.strictEqual(selection.model, "gpt-5.6-sol");
  });

  it("skips disabled and unavailable instances", () => {
    const controllerModel = makeModel("opencodeV2", "ox");
    const code = invalidModelCode(() =>
      resolveControllerCreateModelSelection({
        requestedModel: "gpt-5.6-sol",
        controllerModel,
        candidates: [
          {
            instanceId: instanceIdOf("off"),
            snapshot: { enabled: false, models: [{ slug: "gpt-5.6-sol" }] },
          },
          {
            instanceId: instanceIdOf("down"),
            snapshot: {
              enabled: true,
              availability: "unavailable" as const,
              models: [{ slug: "gpt-5.6-sol" }],
            },
          },
        ],
      }),
    );
    assert.strictEqual(code, "invalid_model");
  });

  it("rejects a model no instance advertises", () => {
    const controllerModel = makeModel("opencodeV2", "ox");
    const code = invalidModelCode(() =>
      resolveControllerCreateModelSelection({
        requestedModel: "nonexistent",
        controllerModel,
        candidates,
      }),
    );
    assert.strictEqual(code, "invalid_model");
  });
});

describe("untrustedThreadContext limits", () => {
  const longText = "x".repeat(50_000);
  const messages = [
    { role: "system", text: "hidden" },
    { role: "user", text: "q1" },
    { role: "assistant", text: longText },
    { role: "user", text: "   " },
    { role: "user", text: "q2", streaming: true },
    { role: "assistant", text: "a2" },
  ];

  it("bounded defaults match the legacy helper output", () => {
    assert.deepStrictEqual(
      untrustedThreadContext(messages, resolveUntrustedContextLimits(undefined)),
      boundedUntrustedThreadContext(messages),
    );
  });

  it("mode full raises ceilings so large messages return whole", () => {
    const context = untrustedThreadContext(
      messages,
      resolveUntrustedContextLimits({ mode: "full" }),
    );
    assert.deepStrictEqual(
      context.map((m) => m.role),
      ["user", "assistant", "assistant"],
    );
    assert.strictEqual(context[1]?.text.length, 50_000);
  });

  it("the caller sets explicit budgets and they are clamped to ceilings", () => {
    const tiny = untrustedThreadContext(
      messages,
      resolveUntrustedContextLimits({ maxMessages: 1, maxTotalChars: 10, maxMessageChars: 5 }),
    );
    assert.deepStrictEqual(tiny, [{ role: "assistant", text: "a2" }]);
    const clamped = resolveUntrustedContextLimits({
      maxMessages: 999_999,
      maxTotalChars: -5,
      maxMessageChars: 0,
      anchor: "oldest",
    });
    assert.strictEqual(clamped.maxMessages, 10_000);
    assert.strictEqual(clamped.maxTotalChars, 1);
    assert.strictEqual(clamped.maxMessageChars, 1);
    assert.strictEqual(clamped.anchor, "oldest");
  });

  it("anchor oldest reads from the start of the conversation", () => {
    const context = untrustedThreadContext(
      messages,
      resolveUntrustedContextLimits({ maxMessages: 2, maxTotalChars: 100, anchor: "oldest" }),
    );
    assert.deepStrictEqual(
      context.map((m) => m.text),
      ["q1", "x".repeat(98)],
    );
  });
});
