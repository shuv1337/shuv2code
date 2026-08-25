/**
 * Clearing a contact's unread count (`docs/ade/MESSENGER-PIVOT.md` §4, M3).
 *
 * ## What "read" means here, and what it does not yet
 *
 * The design fires this on **conversation focus and at-bottom**. Focus lands in
 * this ticket; at-bottom does not, and the reason is a boundary rather than an
 * oversight. The only component that knows whether the reader is at the bottom
 * of a thread is `ChatView`, via `resolveTimelineIsAtEnd` and its private
 * `isAtEndRef` — and `components/chat/**` is closed to this pivot except for
 * the single `TimelineRowHost` export M4 owns (§5). Threading an
 * `onAtEndChange` prop out of `ChatView` here would spend M4's one permitted
 * edit on a different ticket's feature.
 *
 * So M3 marks read on the honest half of the signal: the captain has this
 * conversation open, in a visible window, with the document focused. That is
 * already correct for the overwhelmingly common case — a captain reading a
 * conversation is at the bottom of it — and it is never *wrong* in the
 * dangerous direction, because the server's mark is monotonic and a re-mark is
 * idempotent.
 *
 * **M4 completes it.** When `BubbleTimeline` lands it owns its own at-end
 * state, and `enabled` below becomes `chatReady && isAtEnd` with no change to
 * anything else in this file. Until then, a captain scrolled far up a long
 * thread has their unread cleared a little early; the alternative — clearing it
 * only on an explicit action — leaves a dot on a conversation they are
 * demonstrably looking at, which is the worse of the two lies.
 */
import type { BotId } from "@shuv2code/contracts";
import { useEffect, useRef } from "react";

import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Fire at most this often per bot. The rail is already live, so a read receipt
 * landing a second late costs nothing; a focus/blur cycle on a flaky window
 * manager firing one write per event costs a round trip each time.
 */
export const MARK_READ_MIN_INTERVAL_MS = 1_000;

export function useBotChatRead(input: {
  readonly botId: BotId;
  /** Whether the captain can actually be said to be reading this conversation. */
  readonly enabled: boolean;
  /**
   * The tail the rail last reported. Re-marking when this moves is what keeps
   * an open conversation's unread count at zero while messages keep arriving —
   * without it, the first message after focus would leave a dot on the row the
   * captain is currently staring at.
   */
  readonly lastMessageAt: string | null;
}): void {
  const environmentId = useAdeEnvironmentId();
  const markRead = useAtomCommand(adeEnvironment.markBotChatRead, { reportFailure: false });
  const lastFiredAt = useRef(0);

  useEffect(() => {
    if (!input.enabled || environmentId === null) {
      return;
    }

    const fire = () => {
      // A backgrounded tab is not a captain reading. Checked at fire time
      // rather than only at subscribe time so a tab that was hidden when the
      // message arrived does not clear the dot the moment it is restored to a
      // different workspace the captain never looked at.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      lastFiredAt.current = Date.now();
      void markRead({ environmentId, input: { botId: input.botId } });
    };

    /**
     * Throttled *only* for the event listeners. A new tail re-runs this effect
     * and must always mark — dropping that one on a rate limit would leave a
     * dot on the conversation the captain is looking at, which is the exact
     * failure this hook exists to prevent. Repeated focus/visibility churn on
     * an unchanged thread has nothing new to say, so it is the churn that gets
     * limited rather than the signal.
     */
    const fireOnEvent = () => {
      if (Date.now() - lastFiredAt.current < MARK_READ_MIN_INTERVAL_MS) {
        return;
      }
      fire();
    };

    fire();
    if (typeof window === "undefined") {
      return;
    }
    window.addEventListener("focus", fireOnEvent);
    document.addEventListener("visibilitychange", fireOnEvent);
    return () => {
      window.removeEventListener("focus", fireOnEvent);
      document.removeEventListener("visibilitychange", fireOnEvent);
    };
    // `lastMessageAt` is a dependency on purpose: a new tail while the
    // conversation is open is exactly when the mark has to move again.
  }, [environmentId, input.botId, input.enabled, input.lastMessageAt, markRead]);
}
