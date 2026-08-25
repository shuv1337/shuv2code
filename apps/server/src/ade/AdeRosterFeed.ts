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

import type { AdeRoster } from "@shuv2code/contracts";

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
  /** Current roster without waiting for a frame. */
  readonly latest: Effect.Effect<AdeRoster>;
  /** Current roster plus subsequent changes (race-free, subscriber-gated). */
  readonly subscribe: Effect.Effect<SnapshotSubscription<AdeRoster>, never, Scope.Scope>;
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

      /**
       * A failed pass is not a reason to tear the rail down. `getRoster` fails
       * only on persistence errors, which are transient far more often than
       * they are terminal; the subscriber keeps its last good frame and the
       * next pass either recovers or keeps failing somewhere louder.
       */
      const readRoster = api
        .getRoster()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logDebug("ADE roster feed pass failed").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
              ),
              null,
            ),
          ),
        );

      const changes = yield* Effect.acquireRelease(PubSub.sliding<AdeRoster>(4), (pubsub) =>
        PubSub.shutdown(pubsub),
      );
      const subscribers = yield* Ref.make(0);
      const published = yield* Ref.make<string | null>(null);

      const pass = Effect.gen(function* () {
        if ((yield* Ref.get(subscribers)) === 0) {
          return;
        }
        const roster = yield* readRoster;
        if (roster === null) {
          return;
        }
        const signature = rosterSignature(roster);
        if ((yield* Ref.get(published)) === signature) {
          return;
        }
        yield* Ref.set(published, signature);
        yield* PubSub.publish(changes, roster);
      });

      // Scoped to the layer: the fiber is interrupted when the layer that built
      // it is released, so a shutting-down server never leaves a pass mid-query.
      yield* Effect.forkScoped(
        Effect.forever(
          pass.pipe(Effect.andThen(Effect.sleep(`${ADE_ROSTER_FEED_INTERVAL_MS} millis`))),
        ),
      );

      const latest = Effect.map(readRoster, (roster) => roster ?? EMPTY_ROSTER);

      return AdeRosterFeed.of({
        latest,
        /**
         * The counter is what makes the fiber free when the rail is closed.
         * Incremented before the snapshot and released with the caller's scope,
         * so a subscriber can never observe a feed that considers itself idle.
         *
         * The snapshot is also what seeds `published`: without it the first
         * pass after a subscribe would republish the frame the subscriber just
         * received as `latest`, and the rail would render twice for nothing.
         */
        subscribe: Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Ref.update(subscribers, (n) => n + 1),
            () => Ref.update(subscribers, (n) => Math.max(0, n - 1)),
          );
          const subscription = yield* subscribeBeforeSnapshotWithoutMutex(changes, latest);
          yield* Ref.set(published, rosterSignature(subscription.latest));
          return subscription;
        }),
      });
    }),
  );
}

/** What the feed reports when a pass failed before it ever had a frame. */
const EMPTY_ROSTER: AdeRoster = { entries: [], projects: [], templates: [], groups: [] };
