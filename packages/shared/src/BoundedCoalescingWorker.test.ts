import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeBoundedCoalescingWorker } from "./BoundedCoalescingWorker.ts";

describe("makeBoundedCoalescingWorker", () => {
  it.live("coalesces adjacent work without crossing barriers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeBoundedCoalescingWorker<string, never, never>({
          capacity: 4,
          coalesce: (current, next) =>
            current.startsWith("delta:") && next.startsWith("delta:")
              ? `delta:${current.slice(6)}${next.slice(6)}`
              : undefined,
          process: (value) =>
            Effect.gen(function* () {
              processed.push(value);
              if (value === "blocked") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue("blocked");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("delta:a");
        yield* worker.enqueue("delta:b");
        yield* worker.enqueue("barrier");
        yield* worker.enqueue("delta:c");
        yield* worker.enqueue("delta:d");

        const queued = yield* worker.diagnostics;
        expect(queued.queued).toBe(3);
        expect(queued.coalesced).toBe(2);
        expect(queued.maxQueued).toBe(3);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["blocked", "delta:ab", "barrier", "delta:cd"]);
      }),
    ),
  );

  it.live("backpressures at capacity and never exceeds its bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const blockedEnqueueCompleted = yield* Deferred.make<void>();
        const worker = yield* makeBoundedCoalescingWorker<string, never, never>({
          capacity: 2,
          coalesce: () => undefined,
          process: (value) =>
            value === "active"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
        });

        yield* worker.enqueue("active");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("queued-1");
        yield* worker.enqueue("queued-2");
        yield* Effect.forkChild(
          worker
            .enqueue("backpressured")
            .pipe(Effect.andThen(Deferred.succeed(blockedEnqueueCompleted, undefined))),
        );
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(blockedEnqueueCompleted)).toBe(false);
        expect((yield* worker.diagnostics).maxQueued).toBe(2);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(blockedEnqueueCompleted);
        yield* worker.drain;
        expect((yield* worker.diagnostics).maxQueued).toBe(2);
      }),
    ),
  );
});
