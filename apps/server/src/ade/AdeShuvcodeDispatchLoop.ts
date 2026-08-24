/**
 * The single shuvcode tool-dispatch consumer (spec §3.2; issue #163).
 *
 * `ProviderDynamicToolsShape.takeSignal` is destructive and single-consumer,
 * and the gate documents that `runShuvcodeDispatchLoop` must run **exactly
 * once per seam** — there is no runtime guard against a second consumer. That
 * makes "where is it forked" an architectural fact, not an implementation
 * detail, so it gets its own layer rather than hiding inside a service that
 * might one day be constructed twice.
 *
 * Parked until server activation, like the S17 health ticker and the S7
 * delivery sweeper. If the shuvcode instance is not routable the loop simply
 * never starts: the app stays navigable while degraded (spec §4.1), and a
 * later restart picks it up.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ADE_SHUVCODE_INSTANCE_ID } from "./AdeShuvcodeChatSession.ts";
import { AdeToolGate } from "./AdeToolGate.ts";

export class AdeShuvcodeDispatchLoop {
  static readonly live: Layer.Layer<
    never,
    never,
    AdeToolGate | ProviderAdapterRegistry.ProviderAdapterRegistry
  > = Layer.effectDiscard(
    Effect.gen(function* () {
      const gate = yield* AdeToolGate;
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;

      /**
       * Resolving the adapter once at boot is not enough. The operator
       * normally starts `shuvcode service start` *after* the server, so at
       * boot the instance is usually not registered yet — and a loop that
       * gave up there would leave every bot's tool calls unanswered for the
       * whole process lifetime. The registry's change feed is the fix: each
       * tick re-resolves, and a rebuilt instance means a brand-new seam, so
       * the old loop must be torn down and replaced rather than kept.
       *
       * Interrupting a live loop across a rebuild is safe: `takeSignal` is
       * buffered and lossless, and re-attach drains provider-side pending
       * calls, so a brief consumer gap costs latency, not calls.
       */
      yield* forkParked(
        Effect.gen(function* () {
          // Subscribe before the first resolve so an instance that registers
          // during startup cannot slip through the gap.
          const changes = yield* adapters.subscribeChanges;
          const nextChange = Stream.runHead(Stream.fromSubscription(changes));
          let announcedIdle = false;

          return yield* Effect.forever(
            Effect.gen(function* () {
              const adapter = yield* Effect.orElseSucceed(
                adapters.getByInstance(ADE_SHUVCODE_INSTANCE_ID),
                () => null,
              );
              const seam = adapter?.dynamicTools ?? null;
              if (seam === null) {
                if (!announcedIdle) {
                  announcedIdle = true;
                  yield* Effect.logInfo(
                    "ADE tool dispatch loop idle: no shuvcode dynamic-tool seam yet; waiting for the instance",
                  );
                }
                // Block on the change feed rather than looping: without this
                // the `forever` below would spin at full tilt.
                return yield* nextChange;
              }
              announcedIdle = false;
              yield* Effect.logInfo("ADE tool dispatch loop started");
              // The loop never returns on its own; it ends only when the
              // instance changes underneath it.
              return yield* Effect.race(gate.runShuvcodeDispatchLoop(seam), nextChange);
            }),
          );
        }).pipe(
          Effect.scoped,
          Effect.catchDefect((defect) =>
            Effect.logWarning("ADE tool dispatch supervisor defect", { defect }),
          ),
        ),
      );
    }),
  );
}
