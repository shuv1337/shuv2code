/**
 * The live contact rail's feed (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M3).
 *
 * `ade.getRoster` on a 15s client poll was survivable while a roster row said
 * "shuv2code · 2 open assignments". It stops being survivable the moment the
 * row says what the bot last *said*: a messenger whose previews are up to
 * fifteen seconds stale does not read as slow, it reads as broken. So the rail
 * moves onto a subscription, modelled on `AdeHealthChecker`'s pill feed — the
 * same `SnapshotSubscription` shape, the same sliding PubSub, the same
 * `Stream.concat(latest, changes)` at the wire.
 *
 * ## Why this recomputes rather than listens
 *
 * The design asks for frames "on bot mutation, needs-you open/resolve, and
 * primary-thread message commit". The first two are ADE's own writes; the
 * third is not. A bot's chat is an ordinary shuv2code thread
 * (`AdeShuvcodeChatSession.ts`), so its messages are committed by the generic
 * projection pipeline, which knows nothing about ADE and should not have to.
 * Reaching into that pipeline to add an ADE-shaped hook would put fleet
 * concerns inside the one component every provider shares — the same mistake
 * §1 refuses to make in `ChatView`.
 *
 * So the feed derives the change instead of being told about it, under three
 * constraints that keep the cost honest:
 *
 * 1. **Subscriber-gated.** With nobody watching the rail, the fiber does
 *    nothing at all. This is not an always-on background poll; it exists for
 *    exactly as long as a captain has the rail open.
 * 2. **Change-gated.** A frame is published only when the projected roster
 *    actually differs from the last one published. An idle fleet with an open
 *    rail produces zero wire traffic.
 * 3. **Bounded.** One pass is `AdeCaptainApi.getRoster`, whose reads are
 *    indexed and bounded by fleet size (§18.1 `maxBots`, default 24).
 *
 * The result is strictly cheaper than what it replaces — one server-side read
 * per interval instead of one round trip per client per interval — and it is
 * *correct* for message commits, which no amount of ADE-side event wiring
 * would have covered without editing the projection pipeline.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { AdeCaptainError, AdeRoster } from "@shuv2code/contracts";

import {
  subscribeBeforeSnapshotWithoutMutex,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";

/**
 * The design's debounce. Fast enough that a reply appears in the rail at the
 * same time it appears in the conversation, slow enough that a streaming turn
 * settling into several rows becomes one frame rather than several.
 */
export const ADE_ROSTER_FEED_INTERVAL_MS = 250;

export interface AdeRosterFeedShape {
  /**
   * Current roster without waiting for a frame.
   *
   * Fails rather than substituting an empty fleet. "The database could not be
   * read" and "you have no bots" are opposite facts, and the second one has a
   * call to action attached — a captain shown the first-project CTA because
   * SQLite hiccuped would go and create a project they already have.
   */
  readonly latest: Effect.Effect<AdeRoster, AdeCaptainError>;
  /** Current roster plus subsequent changes (race-free, subscriber-gated). */
  readonly subscribe: Effect.Effect<SnapshotSubscription<AdeRoster>, AdeCaptainError, Scope.Scope>;
}

/**
 * What "the same roster" means to the feed.
 *
 * Structural rather than referential: `getRoster` builds fresh objects every
 * pass, so identity would report a change every interval and defeat the whole
 * gate. The payload is bounded by fleet size and every field is already
 * wire-encodable, which is what makes serializing it a fair comparison rather
 * than a hidden cost.
 */
export const rosterSignature = (roster: AdeRoster): string => JSON.stringify(roster);

export class AdeRosterFeed extends Context.Service<AdeRosterFeed, AdeRosterFeedShape>()(
  "shuv2code/ade/AdeRosterFeed",
) {
  static readonly layer: Layer.Layer<AdeRosterFeed, never, AdeCaptainApi> = Layer.effect(
    AdeRosterFeed,
    Effect.gen(function* () {
      const api = yield* AdeCaptainApi;

      const latest = api.getRoster();

      const changes = yield* Effect.acquireRelease(PubSub.sliding<AdeRoster>(4), (pubsub) =>
        PubSub.shutdown(pubsub),
      );
      const subscribers = yield* Ref.make(0);

      /**
       * One pass: read, publish, let each subscriber decide whether it is news.
       *
       * There is deliberately **no shared "last published" signature**. The
       * first version had one, and it starved subscribers: a new subscriber
       * seeded the shared gate with its own snapshot, so any change that landed
       * between an existing subscriber's last frame and that subscription was
       * marked as already-published and never reached them. The rail would
       * simply stop updating for whoever had been watching longest, and only
       * when a second client connected — which is exactly the bug that does not
       * reproduce while you are testing with one tab open.
       *
       * De-duplication belongs per subscriber, because "have I seen this?" is a
       * per-subscriber question. Publishing unconditionally into an in-process
       * sliding PubSub costs nothing; the per-subscriber filter below is what
       * keeps unchanged frames off the wire, and it runs before the RPC stream
       * encodes anything.
       *
       * A failed pass is not a reason to tear the rail down: `getRoster` fails
       * on persistence errors, which are transient far more often than terminal.
       * Subscribers keep their last good frame and the next pass either recovers
       * or keeps failing somewhere louder. A *subscribe-time* failure is a
       * different matter and propagates — see `latest`.
       */
      const pass = Effect.gen(function* () {
        if ((yield* Ref.get(subscribers)) === 0) {
          return;
        }
        yield* PubSub.publish(changes, yield* latest);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("ADE roster feed pass failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );

      // Scoped to the layer: the fiber is interrupted when the layer that built
      // it is released, so a shutting-down server never leaves a pass mid-query.
      yield* Effect.forkScoped(
        Effect.forever(
          pass.pipe(Effect.andThen(Effect.sleep(`${ADE_ROSTER_FEED_INTERVAL_MS} millis`))),
        ),
      );

      return AdeRosterFeed.of({
        latest,
        /**
         * The counter is what makes the fiber free when the rail is closed.
         * Incremented before the snapshot and released with the caller's scope,
         * so a subscriber can never observe a feed that considers itself idle.
         *
         * `seen` starts at this subscriber's own snapshot, which is what stops
         * the rail rendering twice for nothing on connect — and, unlike the
         * shared gate it replaces, seeding it cannot affect anybody else.
         */
        subscribe: Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Ref.update(subscribers, (n) => n + 1),
            () => Ref.update(subscribers, (n) => Math.max(0, n - 1)),
          );
          const subscription = yield* subscribeBeforeSnapshotWithoutMutex(changes, latest);
          const seen = yield* Ref.make(rosterSignature(subscription.latest));
          return {
            latest: subscription.latest,
            changes: subscription.changes.pipe(
              Stream.filterEffect((roster) =>
                Effect.gen(function* () {
                  const signature = rosterSignature(roster);
                  if ((yield* Ref.get(seen)) === signature) {
                    return false;
                  }
                  yield* Ref.set(seen, signature);
                  return true;
                }),
              ),
            ),
          } satisfies SnapshotSubscription<AdeRoster>;
        }),
      });
    }),
  );
}
