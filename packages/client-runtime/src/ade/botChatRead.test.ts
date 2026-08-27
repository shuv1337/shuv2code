import { describe, expect, it } from "vite-plus/test";

import {
  BOT_CHAT_READ_DWELL_MS,
  botChatReadMarkKey,
  hasDwelledOnBotChat,
  shouldMarkBotChatRead,
  type BotChatReadMark,
} from "./botChatRead.ts";

/**
 * Replays a sequence of roster frames through the decision the way the effect
 * does — carrying the recorded mark forward — and reports which frames fired.
 */
function replay(
  botId: string,
  frames: ReadonlyArray<{ readonly unreadCount: number; readonly lastMessageAt: string | null }>,
): ReadonlyArray<boolean> {
  let markedFor: BotChatReadMark = null;
  return frames.map((frame) => {
    const fired = shouldMarkBotChatRead({ botId, ...frame, markedFor });
    if (fired) {
      markedFor = botChatReadMarkKey({ botId, lastMessageAt: frame.lastMessageAt });
    }
    return fired;
  });
}

describe("shouldMarkBotChatRead", () => {
  it("marks on arrival, before anything has happened", () => {
    expect(replay("bot_1", [{ unreadCount: 0, lastMessageAt: null }])).toEqual([true]);
  });

  it("does not fire again on the frame that reports its own mark landing", () => {
    // 3 unread → mark → the next frame says 0. Firing on that doubles every
    // write for no new information.
    expect(
      replay("bot_1", [
        { unreadCount: 3, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
      ]),
    ).toEqual([true, false, false]);
  });

  it("marks again when the bot speaks while the conversation is open", () => {
    expect(
      replay("bot_1", [
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 1, lastMessageAt: "2026-08-24T10:01:00.000Z" },
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:01:00.000Z" },
      ]),
    ).toEqual([true, true, false]);
  });

  /**
   * D7, and the case the previous preview-keyed trigger was permanently dead
   * for. A bot with an open `form` request has `lastMessage === null` **by
   * construction** — that is the suppression rule keeping a secure answer off
   * the rail — so the preview timestamp never moves no matter how much the bot
   * says. Keyed on it, the captain sat in a focused conversation watching the
   * unread badge climb on the row they were looking at.
   */
  it("keeps marking a form-open bot, whose preview is null forever", () => {
    const fired = replay("bot_1", [
      { unreadCount: 0, lastMessageAt: null },
      // The bot asks for a value; suppression kicks in and stays on.
      { unreadCount: 1, lastMessageAt: null },
      { unreadCount: 0, lastMessageAt: null },
      { unreadCount: 2, lastMessageAt: null },
      { unreadCount: 0, lastMessageAt: null },
    ]);

    expect(fired).toEqual([true, true, false, true, false]);
    // The badge is cleared every time it moves off zero, which is what "stays
    // at 0 while focused" means from the client's side.
    expect(fired[1]).toBe(true);
    expect(fired[3]).toBe(true);
  });

  /**
   * The other dead case: an assistant row keeps its first-chunk `created_at`
   * for the whole turn, so a streaming reply can leave the preview timestamp
   * standing still across several settled messages.
   */
  it("keeps marking when a streamed tail pins the preview timestamp", () => {
    expect(
      replay("bot_1", [
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 1, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 1, lastMessageAt: "2026-08-24T10:00:00.000Z" },
      ]),
    ).toEqual([true, true, false, true]);
  });

  it("marks when the captain's own message advances a thread with nothing unread", () => {
    // Sending never changes the unread count, but the conversation did move.
    expect(
      replay("bot_1", [
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:00:00.000Z" },
        { unreadCount: 0, lastMessageAt: "2026-08-24T10:05:00.000Z" },
      ]),
    ).toEqual([true, true]);
  });

  it("marks afresh after switching to a different contact", () => {
    const markedFor = botChatReadMarkKey({ botId: "bot_1", lastMessageAt: null });
    expect(
      shouldMarkBotChatRead({
        botId: "bot_2",
        unreadCount: 0,
        lastMessageAt: null,
        markedFor,
      }),
    ).toBe(true);
  });
});

describe("botChatReadMarkKey", () => {
  it("separates an empty thread from one whose tail is the empty string", () => {
    expect(botChatReadMarkKey({ botId: "bot_1", lastMessageAt: null })).toBe("bot_1:");
    expect(botChatReadMarkKey({ botId: "bot_1", lastMessageAt: "x" })).toBe("bot_1:x");
  });
});

describe("hasDwelledOnBotChat", () => {
  /**
   * The gate that replaces the intent M8 removed.
   *
   * Before #217, reaching a readable conversation required pressing "Start
   * chatting". Navigation alone gets there now, so without this a rail sweep
   * clears every unread dot it passes over — irreversibly, because the
   * server's mark is monotonic.
   */
  it("marks nothing when the captain sweeps past", () => {
    // Arrow-keying down the rail: ~1s on a contact, well inside the gate.
    expect(hasDwelledOnBotChat({ readableSinceMs: 0, nowMs: 1_000 })).toBe(false);
  });

  it("marks once the captain actually stays", () => {
    expect(hasDwelledOnBotChat({ readableSinceMs: 0, nowMs: 2_000 })).toBe(true);
  });

  it("opens exactly at the threshold", () => {
    expect(hasDwelledOnBotChat({ readableSinceMs: 0, nowMs: BOT_CHAT_READ_DWELL_MS - 1 })).toBe(
      false,
    );
    expect(hasDwelledOnBotChat({ readableSinceMs: 0, nowMs: BOT_CHAT_READ_DWELL_MS })).toBe(true);
  });

  it("never marks while the conversation is not readable", () => {
    // `null` is what the caller writes on unmount, on a bot swap, and whenever
    // the captain scrolls off the tail — which is what keeps the dwell
    // continuous rather than cumulative.
    expect(hasDwelledOnBotChat({ readableSinceMs: null, nowMs: 10_000 })).toBe(false);
  });

  it("restarts rather than accumulates across a bounce", () => {
    // Two 1s visits are not one 2s visit.
    expect(hasDwelledOnBotChat({ readableSinceMs: 5_000, nowMs: 6_000 })).toBe(false);
  });
});
