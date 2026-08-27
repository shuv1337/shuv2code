/**
 * Clearing a contact's unread count on mobile
 * (`docs/ade/MESSENGER-PIVOT.md` §4, M3 / M8).
 *
 * The *decision* — when a frame warrants a mark, and how long the captain has
 * to stay before one counts — is `@shuv2code/client-runtime/ade/bot-chat-read`,
 * shared verbatim with web. Only the presence signal differs: a phone has no
 * `document.hasFocus()`, so "the captain is reading this" is the conjunction of
 * a focused screen and a foregrounded app (`isBotChatReadable`).
 *
 * The dwell gate matters *more* here than on web. A flick down a contact list
 * is cheaper than an arrow key, and the server's mark is monotonic — a sweep
 * past twenty bots would irreversibly clear twenty dots the captain never read.
 */
import type { BotId, EnvironmentId } from "@shuv2code/contracts";
import {
  BOT_CHAT_READ_DWELL_MS,
  botChatReadMarkKey,
  hasDwelledOnBotChat,
  shouldMarkBotChatRead,
} from "@shuv2code/client-runtime/ade/bot-chat-read";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { adeEnvironment } from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";
import { isBotChatReadable } from "./fleet.logic";

/**
 * Fire at most this often per bot. The roster is already live, so a read
 * receipt landing a second late costs nothing; an app that bounces through
 * `inactive` on every notification banner would otherwise buy a round trip per
 * banner.
 */
export const MARK_READ_MIN_INTERVAL_MS = 1_000;

export function useBotChatRead(input: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  /** The thread is mounted and the conversation is actually readable. */
  readonly chatReady: boolean;
  /** The rail's current unread count — the primary re-fire trigger. */
  readonly unreadCount: number;
  /** The tail the roster last reported; moves when the captain's own send lands. */
  readonly lastMessageAt: string | null;
}): void {
  const screenFocused = useIsFocused();
  const appState = useAppStateStatus();
  const markRead = useAtomCommand(adeEnvironment.markBotChatRead, { reportFailure: false });
  const lastFiredAt = useRef(0);

  const enabled = isBotChatReadable({
    chatReady: input.chatReady,
    screenFocused,
    appState,
  });

  /**
   * The dwell gate. `enabled` says the conversation is *readable*; this says
   * the captain has actually stayed on it. State rather than a ref, because the
   * marking effect below has to re-run when it flips.
   */
  const [dwelled, setDwelled] = useState(false);
  /** When the conversation last *became* readable, or null while it is not. */
  const readableSince = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      readableSince.current = null;
      setDwelled(false);
      return;
    }
    readableSince.current = Date.now();
    setDwelled(false);
    const timer = setTimeout(() => setDwelled(true), BOT_CHAT_READ_DWELL_MS);
    return () => {
      clearTimeout(timer);
      readableSince.current = null;
    };
  }, [enabled, input.botId]);

  /**
   * What the last mark was *for*, so a roster frame reporting the count
   * settling to zero *because of that mark* does not fire a second write.
   */
  const markedFor = useRef<string | null>(null);
  const environmentId = input.environmentId;

  useEffect(() => {
    if (!enabled || !dwelled || environmentId === null) {
      markedFor.current = null;
      return;
    }
    // Re-judged against the timestamp rather than trusting the timer: a timer
    // throttled by a backgrounded JS thread must not open the gate on its own.
    if (!hasDwelledOnBotChat({ readableSinceMs: readableSince.current, nowMs: Date.now() })) {
      return;
    }
    if (
      !shouldMarkBotChatRead({
        botId: input.botId,
        unreadCount: input.unreadCount,
        lastMessageAt: input.lastMessageAt,
        markedFor: markedFor.current,
      })
    ) {
      return;
    }
    /*
     * Throttle only re-fires, never the first mark for a given tail. Dropping
     * the mark for a *new* message on a rate limit would leave a dot on the
     * conversation the captain is looking at, which is the failure this hook
     * exists to prevent; repeated foreground churn on an unchanged thread has
     * nothing new to say and is what gets limited.
     */
    if (
      markedFor.current !== null &&
      Date.now() - lastFiredAt.current < MARK_READ_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastFiredAt.current = Date.now();
    markedFor.current = botChatReadMarkKey({
      botId: input.botId,
      lastMessageAt: input.lastMessageAt,
    });
    void markRead({ environmentId, input: { botId: input.botId } });
    // Both liveness fields are dependencies on purpose: a bot speaking while
    // the conversation is open is exactly when the mark has to move again, and
    // `unreadCount` is the only one of the two that always notices.
  }, [
    dwelled,
    enabled,
    environmentId,
    input.botId,
    input.lastMessageAt,
    input.unreadCount,
    markRead,
  ]);
}

/** RN's app-state as a render value, so the read gate can depend on it. */
function useAppStateStatus(): AppStateStatus {
  const [status, setStatus] = useState<AppStateStatus>(() => AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setStatus);
    return () => subscription.remove();
  }, []);
  return status;
}
