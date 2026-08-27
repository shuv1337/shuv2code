/**
 * When an open conversation should move its read mark
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M3 / #196).
 *
 * Pure and separate from `useBotChatRead` so the decision can be driven through
 * a sequence of roster frames in a test. The bug this exists to pin down was
 * invisible in the hook: the re-fire trigger was keyed on the preview
 * timestamp, and there are two whole classes of conversation where that value
 * never moves while messages keep arriving.
 */

/** What a mark was last sent *for*, so the next frame can tell what changed. */
export type BotChatReadMark = string | null;

/**
 * The key a mark is recorded under. Includes the tail so "the thread advanced"
 * is detectable, and the bot so switching contacts always marks afresh.
 */
export const botChatReadMarkKey = (input: {
  readonly botId: string;
  readonly lastMessageAt: string | null;
}): string => `${input.botId}:${input.lastMessageAt ?? ""}`;

/**
 * Whether this roster frame warrants a mark.
 *
 * Three things do, and the first is the one that was missing:
 *
 * 1. **Anything unread.** `unreadCount` is the only signal that always moves
 *    when a bot speaks. The preview does not: a bot with an open `form` request
 *    has `lastMessage === null` *by construction* — that is the suppression
 *    rule keeping secure answers off the rail — so a preview-keyed trigger is
 *    permanently dead for exactly the bot most actively talking to the captain.
 *    A streamed reply fails it from the other side, keeping its first-chunk
 *    `created_at` for the whole turn.
 * 2. **The thread advanced past what the last mark covered.** This catches the
 *    captain's own message landing, which never changes the unread count.
 * 3. **Arriving at the conversation.** No mark recorded yet.
 *
 * What deliberately does *not*: a frame that only reports the count settling to
 * zero because of the mark we just sent. Firing on that doubles every write.
 */
export function shouldMarkBotChatRead(input: {
  readonly botId: string;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly markedFor: BotChatReadMark;
}): boolean {
  if (input.unreadCount > 0) {
    return true;
  }
  return input.markedFor !== botChatReadMarkKey(input);
}

/**
 * How long a conversation must sit open before its unread dot may be cleared.
 *
 * ## Why this exists (#217 / M8)
 *
 * M3 and M4 built read-marking on a premise that M8 quietly removed. Reaching
 * `chatReady` used to require the captain to press "Start chatting" — an
 * explicit act of intent — so "this conversation is open and at the bottom"
 * was a safe proxy for "the captain is reading it". M8 made opening the
 * conversation *itself* the connect, which is the right product call and also
 * means `chatReady` is now reached with **zero intent**: arrow-keying down the
 * contact rail mounts, connects and marks-read every bot it passes over.
 *
 * That is a destructive default. The mark is monotonic on the server, so a
 * sweep past twenty bots irreversibly wipes twenty unread dots the captain
 * never looked at — the one direction M3 explicitly called out as the
 * dangerous one.
 *
 * A dwell gate restores the missing intent without reintroducing a button:
 * staying on a conversation *is* the signal, and 1.5s is long enough to
 * exclude keyboard sweeps while being far below the time it takes to read even
 * one message. It is deliberately a *floor on continuous presence*, not a
 * debounce — leaving and returning restarts it, because a conversation the
 * captain bounced off has not been read.
 */
export const BOT_CHAT_READ_DWELL_MS = 1_500;

/**
 * Has this conversation been continuously readable for long enough to count as
 * read?
 *
 * `readableSinceMs` is the timestamp at which the conversation *last became*
 * ready-and-at-end, or `null` whenever it is not currently both. The caller
 * resets it to `null` on unmount, on a bot swap, and whenever the captain
 * scrolls away from the tail, which is what makes the dwell continuous rather
 * than cumulative.
 */
export function hasDwelledOnBotChat(input: {
  readonly readableSinceMs: number | null;
  readonly nowMs: number;
  readonly dwellMs?: number;
}): boolean {
  if (input.readableSinceMs === null) return false;
  return input.nowMs - input.readableSinceMs >= (input.dwellMs ?? BOT_CHAT_READ_DWELL_MS);
}
