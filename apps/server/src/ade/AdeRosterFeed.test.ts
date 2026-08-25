/**
 * The rail's live feed (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M3 / #196).
 *
 * The claim under test is the one that broke under review: de-duplication is a
 * per-subscriber question, and answering it with one shared "last published"
 * signature starves whoever has been watching longest the moment a second
 * client connects.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { AdeRoster, BotId, BotName } from "@shuv2code/contracts";
import { AdeCaptainError } from "@shuv2code/contracts";

import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { ADE_ROSTER_FEED_INTERVAL_MS, AdeRosterFeed, rosterSignature } from "./AdeRosterFeed.ts";

const rosterWith = (names: ReadonlyArray<string>): AdeRoster =>
  ({
    entries: names.map((name, index) => ({
      bot: { id: `bot_${index}` as BotId, name: name as BotName },
      projectName: null,
      hasActivePrimarySession: false,
      openAssignmentCount: 0,
      lastMessage: null,
      attention: null,
      unreadCount: 0,
    })),
    projects: [],
    templates: [],
    groups: [],
  }) as unknown as AdeRoster;

/**
 * A captain API whose roster is a mutable cell, so a test can land a change
 * between two subscriptions the way a real fleet does.
 */
const stubApi = (state: Ref.Ref<{ roster: AdeRoster; fail: boolean }>) =>
  Layer.succeed(AdeCaptainApi, {
    getRoster: () =>
      Effect.flatMap(Ref.get(state), (current) =>
        current.fail
          ? Effect.fail(
              new AdeCaptainError({ reason: "persistence_failed", message: "disk went away" }),
            )
          : Effect.succeed(current.roster),
      ),
  } as unknown as AdeCaptainApi["Service"]);

/** Advance past one feed pass and let the published frame land. */
const tick = TestClock.adjust(`${ADE_ROSTER_FEED_INTERVAL_MS + 10} millis`);

describe("AdeRosterFeed", () => {
  /**
   * The starvation regression, stated exactly as review did: A is subscribed, a
   * change lands, B subscribes before the next pass — A must still receive the
   * frame covering that change.
   *
   * Under the shared-gate version B's snapshot marked the new roster as already
   * published, so A never heard about it. The rail simply stopped updating for
   * the client that had been watching longest, and only once a second one
   * connected: the failure mode that cannot reproduce with one tab open.
   */
  it.effect("does not let a new subscriber starve an existing one", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ roster: rosterWith(["Firstmate"]), fail: false });

      yield* Effect.gen(function* () {
        const feed = yield* AdeRosterFeed;

        const scopeA = yield* Scope.make();
        const a = yield* Scope.provide(scopeA)(feed.subscribe);
        const receivedByA = yield* Ref.make<ReadonlyArray<string>>([]);
        const pumpA = yield* Effect.forkChild(
          Stream.runForEach(a.changes, (roster) =>
            Ref.update(receivedByA, (seen) => [...seen, rosterSignature(roster)]),
          ),
        );

        // A change lands while only A is watching.
        const changed = rosterWith(["Firstmate", "Coder"]);
        yield* Ref.update(state, (current) => ({ ...current, roster: changed }));

        // B subscribes *before* the pass that would have carried it.
        const scopeB = yield* Scope.make();
        const b = yield* Scope.provide(scopeB)(feed.subscribe);
        assert.equal(rosterSignature(b.latest), rosterSignature(changed));

        yield* tick;
        yield* tick;

        // The whole defect: A must have been told.
        const seen = yield* Ref.get(receivedByA);
        assert.include(seen, rosterSignature(changed));

        yield* Fiber.interrupt(pumpA);
        yield* Scope.close(scopeA, Exit.void);
        yield* Scope.close(scopeB, Exit.void);
      }).pipe(Effect.provide(AdeRosterFeed.layer.pipe(Layer.provide(stubApi(state)))));
    }),
  );

  it.effect("does not replay a subscriber's own opening snapshot back at it", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ roster: rosterWith(["Firstmate"]), fail: false });

      yield* Effect.gen(function* () {
        const feed = yield* AdeRosterFeed;
        const scope = yield* Scope.make();
        const subscription = yield* Scope.provide(scope)(feed.subscribe);
        const received = yield* Ref.make(0);
        const pump = yield* Effect.forkChild(
          Stream.runForEach(subscription.changes, () => Ref.update(received, (n) => n + 1)),
        );

        // Nothing changes across several passes.
        yield* tick;
        yield* tick;
        yield* tick;

        assert.equal(yield* Ref.get(received), 0);

        yield* Fiber.interrupt(pump);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(AdeRosterFeed.layer.pipe(Layer.provide(stubApi(state)))));
    }),
  );

  it.effect("delivers a change to a lone subscriber exactly once", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ roster: rosterWith(["Firstmate"]), fail: false });

      yield* Effect.gen(function* () {
        const feed = yield* AdeRosterFeed;
        const scope = yield* Scope.make();
        const subscription = yield* Scope.provide(scope)(feed.subscribe);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const pump = yield* Effect.forkChild(
          Stream.runForEach(subscription.changes, (roster) =>
            Ref.update(received, (seen) => [...seen, rosterSignature(roster)]),
          ),
        );

        const changed = rosterWith(["Firstmate", "Coder"]);
        yield* Ref.update(state, (current) => ({ ...current, roster: changed }));
        yield* tick;
        yield* tick;
        yield* tick;

        // Republishing an unchanged roster every 250ms is what the
        // per-subscriber filter exists to keep off the wire.
        assert.deepEqual(yield* Ref.get(received), [rosterSignature(changed)]);

        yield* Fiber.interrupt(pump);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(AdeRosterFeed.layer.pipe(Layer.provide(stubApi(state)))));
    }),
  );

  /**
   * "The database could not be read" and "you have no bots" are opposite facts,
   * and the second one has a call to action attached — the first-project CTA.
   * Substituting an empty roster on failure would offer a captain a project
   * they already have.
   */
  it.effect("surfaces a subscribe-time read failure instead of an empty fleet", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ roster: rosterWith(["Firstmate"]), fail: true });

      yield* Effect.gen(function* () {
        const feed = yield* AdeRosterFeed;
        const scope = yield* Scope.make();
        const result = yield* Effect.result(Scope.provide(scope)(feed.subscribe));

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.reason, "persistence_failed");
        }
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(AdeRosterFeed.layer.pipe(Layer.provide(stubApi(state)))));
    }),
  );

  it.effect("keeps the fiber alive across a failing pass", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make({ roster: rosterWith(["Firstmate"]), fail: false });

      yield* Effect.gen(function* () {
        const feed = yield* AdeRosterFeed;
        const scope = yield* Scope.make();
        const subscription = yield* Scope.provide(scope)(feed.subscribe);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const pump = yield* Effect.forkChild(
          Stream.runForEach(subscription.changes, (roster) =>
            Ref.update(received, (seen) => [...seen, rosterSignature(roster)]),
          ),
        );

        // A transient persistence failure must not tear the rail down; the
        // subscriber keeps its last good frame and the next pass recovers.
        yield* Ref.update(state, (current) => ({ ...current, fail: true }));
        yield* tick;
        yield* tick;

        const recovered = rosterWith(["Firstmate", "Coder"]);
        yield* Ref.set(state, { roster: recovered, fail: false });
        yield* tick;
        yield* tick;

        assert.include(yield* Ref.get(received), rosterSignature(recovered));

        yield* Fiber.interrupt(pump);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(AdeRosterFeed.layer.pipe(Layer.provide(stubApi(state)))));
    }),
  );
});
