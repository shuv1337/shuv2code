/**
 * A serial worker with a hard queue bound and lossless adjacent coalescing.
 *
 * When the queue reaches capacity, enqueue backpressures until the consumer
 * takes an item. The optional coalescer may replace only the newest queued
 * item, so it cannot reorder work across lifecycle barriers.
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as TxRef from "effect/TxRef";

export interface BoundedCoalescingWorkerDiagnostics {
  readonly capacity: number;
  readonly queued: number;
  readonly active: boolean;
  readonly maxQueued: number;
  readonly enqueued: number;
  readonly coalesced: number;
  readonly processed: number;
}

export interface BoundedCoalescingWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly diagnostics: Effect.Effect<BoundedCoalescingWorkerDiagnostics>;
}

interface WorkerState<A> {
  readonly queue: ReadonlyArray<A>;
  readonly active: boolean;
  readonly maxQueued: number;
  readonly enqueued: number;
  readonly coalesced: number;
  readonly processed: number;
}

export const makeBoundedCoalescingWorker = <A, E, R>(options: {
  readonly capacity: number;
  readonly coalesce: (current: A, next: A) => A | undefined;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<BoundedCoalescingWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      return yield* Effect.die(
        new Error("BoundedCoalescingWorker capacity must be a positive safe integer"),
      );
    }

    const stateRef = yield* TxRef.make<WorkerState<A>>({
      queue: [],
      active: false,
      maxQueued: 0,
      enqueued: 0,
      coalesced: 0,
      processed: 0,
    });

    const take = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.queue.length === 0 ? Effect.txRetry : Effect.void)),
      Effect.flatMap((state) => {
        const item = state.queue[0]!;
        return TxRef.set(stateRef, {
          ...state,
          queue: state.queue.slice(1),
          active: true,
        }).pipe(Effect.as(item));
      }),
      Effect.tx,
    );

    const markProcessed = TxRef.update(stateRef, (state) => ({
      ...state,
      active: false,
      processed: state.processed + 1,
    })).pipe(Effect.tx);

    yield* take.pipe(
      Effect.flatMap((item) => options.process(item).pipe(Effect.ensuring(markProcessed))),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: BoundedCoalescingWorker<A>["enqueue"] = (item) =>
      TxRef.get(stateRef).pipe(
        Effect.flatMap((state) => {
          const lastIndex = state.queue.length - 1;
          const current = state.queue[lastIndex];
          const merged = current === undefined ? undefined : options.coalesce(current, item);
          if (merged !== undefined) {
            const queue = state.queue.slice();
            queue[lastIndex] = merged;
            return TxRef.set(stateRef, {
              ...state,
              queue,
              enqueued: state.enqueued + 1,
              coalesced: state.coalesced + 1,
            });
          }
          if (state.queue.length >= options.capacity) {
            return Effect.txRetry;
          }
          const queue = [...state.queue, item];
          return TxRef.set(stateRef, {
            ...state,
            queue,
            maxQueued: Math.max(state.maxQueued, queue.length),
            enqueued: state.enqueued + 1,
          });
        }),
        Effect.tx,
      );

    const drain: BoundedCoalescingWorker<A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) =>
        state.active || state.queue.length > 0 ? Effect.txRetry : Effect.void,
      ),
      Effect.asVoid,
      Effect.tx,
    );

    const diagnostics: BoundedCoalescingWorker<A>["diagnostics"] = TxRef.get(stateRef).pipe(
      Effect.map((state) => ({
        capacity: options.capacity,
        queued: state.queue.length,
        active: state.active,
        maxQueued: state.maxQueued,
        enqueued: state.enqueued,
        coalesced: state.coalesced,
        processed: state.processed,
      })),
      Effect.tx,
    );

    return { enqueue, drain, diagnostics } satisfies BoundedCoalescingWorker<A>;
  });
