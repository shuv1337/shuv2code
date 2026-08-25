/**
 * The rail's vocabulary, pinned (`docs/ade/MESSENGER-PIVOT.md` §6, M3).
 *
 * These are the design's named claims — preview precedence, truncation, author
 * attribution, and the one that matters most: that a secure answer has no path
 * into a preview. The wired-up half (unread arithmetic across a read mark, and
 * the secret's absence from a real payload) lives in
 * `AdeCaptainApiRosterLiveness.test.ts`, against a real database.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ADE_ROSTER_PREVIEW_MAX_LENGTH,
  AdeRosterAttention as AdeRosterAttentionSchema,
  AdeRosterLastMessage,
} from "@shuv2code/contracts";

import {
  ADE_UNREAD_DISPLAY_CAP,
  attentionLineFor,
  clampUnreadCount,
  isFleetInjectedMessageId,
  messageAuthorFor,
  resolveAttention,
  resolveLastMessage,
  suppressesPreview,
  toPreviewLine,
} from "./adeRosterLiveness.ts";

import type { LatestThreadMessageRow, OpenAttentionRow } from "./adeRosterLiveness.ts";
import { ADE_BOT_THREAD_ID_PREFIX, botIdFromThreadId } from "./adeRosterLiveness.ts";
import { adeBotThreadId } from "./AdeShuvcodeChatSession.ts";

/**
 * The projection joins `ade_bots` to the thread table by string concatenation
 * rather than by calling `adeBotThreadId`, so this is the guard that keeps the
 * two definitions of a bot's thread identity from drifting apart silently.
 */
describe("ADE_BOT_THREAD_ID_PREFIX", () => {
  it("still spells the same thread id the chat session mints", () => {
    const botId = "bot_1" as Parameters<typeof adeBotThreadId>[0];
    expect(`${ADE_BOT_THREAD_ID_PREFIX}${botId}`).toBe(adeBotThreadId(botId));
    expect(botIdFromThreadId(adeBotThreadId(botId))).toBe(botId);
  });
});

const message = (overrides: Partial<LatestThreadMessageRow> = {}): LatestThreadMessageRow => ({
  thread_id: "ade-bot-bot_1",
  message_id: "m1",
  role: "assistant",
  text: "On it.",
  created_at: "2026-08-24T10:00:00.000Z",
  ...overrides,
});

describe("messageAuthorFor", () => {
  it("names the captain on a message the captain actually typed", () => {
    expect(messageAuthorFor({ role: "user", messageId: "m1" })).toBe("captain");
    expect(messageAuthorFor({ role: "assistant", messageId: "assistant:x" })).toBe("bot");
  });

  it("attributes an unrecognised role to neither party", () => {
    // A future provider role must not be silently printed as the bot speaking.
    expect(messageAuthorFor({ role: "tool", messageId: "m1" })).toBe("system");
    expect(messageAuthorFor({ role: "", messageId: "m1" })).toBe("system");
  });

  /**
   * The two row classes the fleet injects as `role: "user"`. Both used to read
   * as the captain, which made the rail print "You: " over text the captain
   * never wrote — an assignment brief the *runner* sent, or a delivery the
   * provider adapter admitted.
   */
  it("does not credit the captain with an assignment brief the runner injected", () => {
    // `AdeAssignmentRunner.ts:142` mints exactly this shape.
    expect(messageAuthorFor({ role: "user", messageId: "ade-assignment:asg_7:brief" })).toBe(
      "system",
    );
  });

  it("does not credit the captain with a synthetic delivery", () => {
    // `OpenCodeV2Adapter.ts:194` — matched as a substring, because the id is
    // minted provider-side and the ingestion path may prefix it.
    expect(messageAuthorFor({ role: "user", messageId: "msg_ade_ab12" })).toBe("system");
    expect(messageAuthorFor({ role: "user", messageId: "user:msg_ade_ab12" })).toBe("system");
  });

  it("does not credit the captain with an automation prompt", () => {
    expect(messageAuthorFor({ role: "user", messageId: "automation:run_3:prompt" })).toBe("system");
  });

  it("still names the captain when the id merely mentions a bot", () => {
    // The markers are anchored; a captain message about an assignment is not
    // an assignment brief.
    expect(messageAuthorFor({ role: "user", messageId: "user:talk-ade-assignment" })).toBe(
      "captain",
    );
  });
});

describe("isFleetInjectedMessageId", () => {
  it("recognises every injection marker and nothing else", () => {
    expect(isFleetInjectedMessageId("ade-assignment:a:brief")).toBe(true);
    expect(isFleetInjectedMessageId("automation:a:prompt")).toBe(true);
    expect(isFleetInjectedMessageId("msg_ade_key")).toBe(true);
    expect(isFleetInjectedMessageId("m1")).toBe(false);
    expect(isFleetInjectedMessageId("")).toBe(false);
  });
});

describe("toPreviewLine", () => {
  it("folds a multi-line message into one printable line", () => {
    expect(toPreviewLine("Done.\n\nOpened PR #12.\n")).toBe("Done. Opened PR #12.");
    expect(toPreviewLine("   spaced   out   ")).toBe("spaced out");
  });

  it("truncates to the wire bound with an ellipsis inside it, not appended", () => {
    const long = "a".repeat(400);
    const preview = toPreviewLine(long);
    expect(preview.length).toBe(ADE_ROSTER_PREVIEW_MAX_LENGTH);
    expect(preview.endsWith("…")).toBe(true);
  });

  /**
   * The unit is UTF-16 code units, because `Schema.isMaxLength` measures
   * `.length`. Truncating to 160 code *points* shipped up to 320 units for an
   * emoji-dense message, which fails to decode — and one roster frame carries
   * the whole fleet, so a single astral character in one bot's last message
   * took the entire rail's liveness down.
   */
  it("bounds the preview in the same unit the contract checks", () => {
    for (const body of ["🚢".repeat(400), `${"a".repeat(158)}🚢${"b".repeat(200)}`]) {
      const preview = toPreviewLine(body);
      expect(preview.length).toBeLessThanOrEqual(ADE_ROSTER_PREVIEW_MAX_LENGTH);
    }
  });

  it("never emits a lone surrogate at the cut", () => {
    // Cutting mid-pair would produce an unpaired high surrogate: still
    // `.length`-legal, but not valid text, and it renders as a replacement box.
    for (let pad = 0; pad < 8; pad += 1) {
      const preview = toPreviewLine(`${"a".repeat(pad)}${"🚢".repeat(200)}`);
      expect(preview.length).toBeLessThanOrEqual(ADE_ROSTER_PREVIEW_MAX_LENGTH);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(preview)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(preview)).toBe(false);
    }
  });

  it("leaves a message that already fits exactly alone", () => {
    const exact = "b".repeat(ADE_ROSTER_PREVIEW_MAX_LENGTH);
    expect(toPreviewLine(exact)).toBe(exact);
  });
});

/**
 * The bound is only worth anything if the *contract* agrees, so this pushes a
 * real emoji-laden preview through the actual decoder rather than re-asserting
 * the same `.length` arithmetic the implementation already used. This is the
 * test that would have caught the code-point/code-unit mismatch.
 */
describe("preview round-trips through the contract", () => {
  const decodeMessage = Schema.decodeUnknownSync(AdeRosterLastMessage);
  const decodeAttention = Schema.decodeUnknownSync(AdeRosterAttentionSchema);

  it("decodes an emoji-dense preview that would have overflowed in code points", () => {
    const resolved = resolveLastMessage({
      rows: [message({ text: `Shipping ${"🚢".repeat(300)} done` })],
      attentionRows: [],
    });
    expect(resolved).not.toBeNull();
    expect(() => decodeMessage(resolved)).not.toThrow();
  });

  it("decodes an emoji-dense attention line too", () => {
    const attention = resolveAttention([{ kind: "approval", title: "🚢".repeat(300) }]);
    expect(attention).not.toBeNull();
    expect(() => decodeAttention(attention)).not.toThrow();
  });

  it("decodes every boundary offset, not just a convenient one", () => {
    // The interesting cases are the ones where the cut lands inside a pair.
    for (let pad = 0; pad < 8; pad += 1) {
      const resolved = resolveLastMessage({
        rows: [message({ text: `${"a".repeat(pad)}${"🚢".repeat(200)}` })],
        attentionRows: [],
      });
      expect(() => decodeMessage(resolved)).not.toThrow();
    }
  });
});

describe("resolveLastMessage", () => {
  it("prefers the newest message", () => {
    const resolved = resolveLastMessage({
      rows: [
        message({ text: "older", created_at: "2026-08-24T09:00:00.000Z" }),
        message({ text: "newer", created_at: "2026-08-24T11:00:00.000Z" }),
      ],
      attentionRows: [],
    });
    expect(resolved?.preview).toBe("newer");
    expect(resolved?.at).toBe("2026-08-24T11:00:00.000Z");
  });

  /**
   * Preview precedence (§4): a bot message outranks a captain message. At the
   * same instant the captain is waiting on the answer, not on an echo of what
   * they just typed.
   */
  it("lets the bot outrank the captain inside one clock tick", () => {
    const resolved = resolveLastMessage({
      rows: [
        message({ role: "user", text: "ship it", created_at: "2026-08-24T10:00:00.000Z" }),
        message({ role: "assistant", text: "shipped", created_at: "2026-08-24T10:00:00.000Z" }),
      ],
      attentionRows: [],
    });
    expect(resolved?.preview).toBe("shipped");
    expect(resolved?.author).toBe("bot");
  });

  it("still shows the captain's own message when it is genuinely the last word", () => {
    const resolved = resolveLastMessage({
      rows: [
        message({ role: "assistant", text: "done", created_at: "2026-08-24T09:00:00.000Z" }),
        message({ role: "user", text: "thanks", created_at: "2026-08-24T10:00:00.000Z" }),
      ],
      attentionRows: [],
    });
    expect(resolved?.preview).toBe("thanks");
    expect(resolved?.author).toBe("captain");
  });

  it("says nothing rather than nothing-shaped for an empty thread", () => {
    expect(resolveLastMessage({ rows: [], attentionRows: [] })).toBeNull();
  });

  it("treats a whitespace-only message as no preview at all", () => {
    // Otherwise the row renders a blank dim line, which reads as a bug.
    expect(
      resolveLastMessage({ rows: [message({ text: "  \n\t " })], attentionRows: [] }),
    ).toBeNull();
  });

  /**
   * The design's named test: **secret payloads absent from previews**. A bot
   * with an open `form` request is a bot that has asked for a value, and M5's
   * secure input is one rendering of exactly that. The preview is withheld by
   * construction — not redacted, not pattern-matched — so no answer, secure or
   * otherwise, has a path onto the rail.
   */
  it("withholds the preview entirely while a form request is open", () => {
    const rows = [
      message({ role: "user", text: "sk-live-DEADBEEF-not-for-the-rail" }),
      message({ role: "assistant", text: "Thanks, stored." }),
    ];
    const attentionRows: ReadonlyArray<OpenAttentionRow> = [
      { kind: "form", title: "Code Monkey is asking you something" },
    ];

    expect(resolveLastMessage({ rows, attentionRows })).toBeNull();
    // And the line that *does* render carries none of it.
    const attention = resolveAttention(attentionRows);
    expect(attention?.line).not.toContain("sk-live");
    expect(attention?.line).toBe("Answer needed: Code Monkey is asking you something");
  });

  it("keeps quoting the thread for every other kind of open item", () => {
    // Suppression is about the form's *answer*, not about attention generally;
    // an approval row still shows what the bot last said underneath it.
    const resolved = resolveLastMessage({
      rows: [message({ text: "Checks passed." })],
      attentionRows: [{ kind: "approval", title: "A change is waiting for your approval" }],
    });
    expect(resolved?.preview).toBe("Checks passed.");
  });
});

describe("suppressesPreview", () => {
  it("triggers on a form item even when a louder item outranks it for the line", () => {
    expect(
      suppressesPreview([
        { kind: "approval", title: "A change is waiting for your approval" },
        { kind: "form", title: "Code Monkey is asking you something" },
      ]),
    ).toBe(true);
  });

  it("stays out of the way when nothing is asking for a value", () => {
    expect(suppressesPreview([])).toBe(false);
    expect(suppressesPreview([{ kind: "stall", title: "Coder has gone quiet" }])).toBe(false);
  });
});

describe("resolveAttention", () => {
  it("has nothing to say when nothing is open", () => {
    expect(resolveAttention([])).toBeNull();
  });

  it("gives the line to the approval, because it is the only kind work waits on", () => {
    const attention = resolveAttention([
      { kind: "kernel-down", title: "The Codex supervisor is not responding" },
      { kind: "approval", title: "shuv2code: a change is waiting for your approval" },
      { kind: "stall", title: "Coder has gone quiet on an assignment" },
    ]);
    expect(attention?.kind).toBe("approval");
    expect(attention?.line).toBe(
      "Approval required: shuv2code: a change is waiting for your approval",
    );
  });

  it("truncates the amber line to the same wire bound as a preview", () => {
    const attention = resolveAttention([{ kind: "approval", title: "x".repeat(400) }]);
    expect((attention?.line ?? "").length).toBe(ADE_ROSTER_PREVIEW_MAX_LENGTH);
  });
});

describe("attentionLineFor", () => {
  it("prefixes each kind with what the captain is being asked to do", () => {
    expect(attentionLineFor({ kind: "approval", title: "t" }).line).toBe("Approval required: t");
    expect(attentionLineFor({ kind: "form", title: "t" }).line).toBe("Answer needed: t");
    expect(attentionLineFor({ kind: "stall", title: "t" }).line).toBe("Needs you: t");
  });
});

describe("clampUnreadCount", () => {
  it("reports a real count up to the badge's cap", () => {
    expect(clampUnreadCount(0)).toBe(0);
    expect(clampUnreadCount(7)).toBe(7);
    expect(clampUnreadCount(ADE_UNREAD_DISPLAY_CAP)).toBe(ADE_UNREAD_DISPLAY_CAP);
  });

  it("stops counting once the number has stopped being information", () => {
    expect(clampUnreadCount(5_000)).toBe(ADE_UNREAD_DISPLAY_CAP);
  });

  it("never reports a negative unread count", () => {
    // A clock skew that put the read mark ahead of every message must read as
    // "nothing unread", not as a negative badge.
    expect(clampUnreadCount(-3)).toBe(0);
  });
});
