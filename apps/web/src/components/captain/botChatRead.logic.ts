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
