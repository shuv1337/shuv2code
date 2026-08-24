/**
 * ProviderSyntheticInput — session-scoped synthetic input seam (ADE §3.4).
 *
 * ADE delivers structured completions (and a new session's persona/memory
 * projection) into a live bot session as *synthetic input*: text the model
 * sees as inbound context without a captain having typed it. Upstream shuvcode
 * exposes this as `POST /session/:id/synthetic`; Codex exposes the equivalent
 * as `thread/inject_items`.
 *
 * The `delivery` distinction is load-bearing, not cosmetic (ADR §13 —
 * steer ≠ cancel): `follow-up` queues the text behind whatever the session is
 * doing, `steer` folds it into the running turn. ADE queues result deliveries
 * and voice digests; only explicit steering uses `steer`.
 *
 * `dedupeKey` is the provider-side idempotency key for the admitted item, so a
 * crash-window replay of an exactly-once delivery is refused by the kernel as
 * well as by ADE's own durable claim.
 *
 * `resume` is the other half of the wake question: admitting an item into an
 * *idle* session normally wakes it and starts a turn. That is what result
 * delivery and steering want — a result nobody reads is not a delivery. It is
 * emphatically not what seeding a session with its persona projection wants,
 * which would spend an unprompted model turn before the captain has said
 * anything.
 *
 * @module provider/Services/ProviderSyntheticInput
 */
import type { ThreadId } from "@shuv2code/contracts";
import type * as Effect from "effect/Effect";

export type ProviderSyntheticDelivery = "follow-up" | "steer";

export interface ProviderSyntheticInputRequest {
  readonly threadId: ThreadId;
  readonly text: string;
  /** Short human-readable label shown alongside the injected item. */
  readonly description?: string;
  /** `follow-up` queues behind the current turn; `steer` folds into it. */
  readonly delivery: ProviderSyntheticDelivery;
  /**
   * Durable claim id. Becomes the admitted item's id, which is what the
   * provider dedupes on — first admission wins, so a redelivery under the same
   * key cannot produce a second item.
   */
  readonly dedupeKey?: string;
  /**
   * Whether admitting this item may wake an idle session and start a turn.
   * Defaults to the provider's own default (wake). Pass `false` for context
   * the model should simply *have* the next time it runs.
   */
  readonly resume?: boolean;
}

export interface ProviderSyntheticInputShape<TError> {
  /**
   * Inject one synthetic item into the thread's live session. Fails when no
   * session is live — callers that need "deliver when a session exists" must
   * check first (ADE's engine defers such batches rather than dropping them).
   */
  readonly inject: (input: ProviderSyntheticInputRequest) => Effect.Effect<void, TError>;
  /** Is this thread's provider session live right now? */
  readonly isLive: (threadId: ThreadId) => Effect.Effect<boolean>;
}
