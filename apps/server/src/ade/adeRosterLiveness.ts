/**
 * Roster liveness projection: previews, unread, attention
 * (`docs/ade/MESSENGER-PIVOT.md` §4, ticket M3 / #196).
 *
 * Everything here is pure and row-shaped, for the same reason `adeNeedsYou.ts`
 * is: the claims worth defending are about *what the rail is allowed to say*,
 * and those are cheaper to pin down against a row literal than against a
 * database. `AdeCaptainApi` supplies the bounded reads; this file decides what
 * they are permitted to become.
 *
 * The load-bearing rule is the last one in this file. A roster preview is the
 * one ADE surface that renders transcript text somewhere the captain did not
 * ask for it — in a list, next to eight other bots, on whatever screen happens
 * to be open. That makes it the wrong place to be clever about redaction, so it
 * is not clever: a bot with an open `form` request has **no** preview at all.
 */
import type { AdeRosterAttention, AdeRosterLastMessage, NeedsYouKind } from "@shuv2code/contracts";
import { ADE_ROSTER_PREVIEW_MAX_LENGTH } from "@shuv2code/contracts";

/**
 * Display cap for the unread badge. Past two digits the number has stopped
 * being information and started being a wall, and counting further costs a
 * longer scan for a string the rail renders as "99+" either way.
 */
export const ADE_UNREAD_DISPLAY_CAP = 99;

/**
 * The prefix half of `adeBotThreadId` (`AdeShuvcodeChatSession.ts`), restated
 * here so the roster projection can join `ade_bots` to the thread table in one
 * set-based query without importing the chat session module — which would drag
 * the orchestration engine, the provider registry and the tool gate into every
 * consumer of a pure projection. `adeRosterLiveness.test.ts` asserts the two
 * cannot drift.
 */
export const ADE_BOT_THREAD_ID_PREFIX = "ade-bot-";

/** Recover the bot a projected thread row belongs to. */
export const botIdFromThreadId = (threadId: string): string =>
  threadId.startsWith(ADE_BOT_THREAD_ID_PREFIX)
    ? threadId.slice(ADE_BOT_THREAD_ID_PREFIX.length)
    : threadId;

/** The tail row of one bot's primary thread, as read from the projection. */
export interface LatestThreadMessageRow {
  readonly thread_id: string;
  readonly message_id: string;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

/**
 * Message-id markers for rows the *fleet* put in a bot's thread rather than the
 * captain (`AdeAssignmentRunner.ts:142`, `OpenCodeV2Adapter.ts:194`,
 * `AutomationService.ts:151`).
 *
 * These all arrive as `role: "user"`, because that is the only role a kernel
 * accepts input on — the role says "this was input", not "a human typed it".
 * The rail is the one surface where that distinction is load-bearing: an
 * assignment brief rendered as "You: Implement the retry…" tells the captain
 * they said something they never said, on a row they will act on.
 *
 * `msg_ade_` is matched as a substring rather than a prefix because the
 * synthetic item id is minted provider-side and the ingestion path may prefix
 * it; the other two are minted here and are always leading.
 */
const ADE_INJECTED_ID_PREFIXES = ["ade-assignment:", "automation:"] as const;
const ADE_SYNTHETIC_ID_MARKER = "msg_ade_";

export function isFleetInjectedMessageId(messageId: string): boolean {
  return (
    ADE_INJECTED_ID_PREFIXES.some((prefix) => messageId.startsWith(prefix)) ||
    messageId.includes(ADE_SYNTHETIC_ID_MARKER)
  );
}

/** One open Needs You item, flattened to what an attention line needs. */
export interface OpenAttentionRow {
  readonly kind: NeedsYouKind;
  readonly title: string;
}

/**
 * Bot messages outrank captain messages at the same instant.
 *
 * Not a tiebreaker for its own sake: a captain who sends a message and gets an
 * answer inside the same clock tick is a captain waiting on the *answer*, and a
 * rail that echoes their own outgoing text back at them has reported the one
 * fact they already know. Kept as an exported constant so the SQL ordering and
 * the precedence test are reading the same rule.
 */
export const THREAD_ROLE_PRECEDENCE: Readonly<Record<string, number>> = {
  assistant: 0,
  user: 1,
};

export const threadRolePrecedence = (role: string): number => THREAD_ROLE_PRECEDENCE[role] ?? 2;

/**
 * Newest first, bot before captain within a tick. Exported so the projection
 * can pick a winner from a handful of candidate rows without a second query.
 */
export const compareLatestMessageRows = (
  left: LatestThreadMessageRow,
  right: LatestThreadMessageRow,
): number => {
  const byTime = right.created_at.localeCompare(left.created_at);
  if (byTime !== 0) return byTime;
  return threadRolePrecedence(left.role) - threadRolePrecedence(right.role);
};

/**
 * Who the rail names as the author.
 *
 * `role` alone is not enough. Everything a kernel accepts as input arrives as
 * `role: "user"`, including the assignment briefs the runner injects and the
 * synthetic deliveries the provider adapter admits — so the role means "this
 * was input", not "a human typed it". Attributing those to the captain makes
 * the rail print "You: Implement the retry budget…" under a bot's name, which
 * tells the captain they said something they never said.
 *
 * `system` is the honest third answer, and it is what an unrecognised role gets
 * too: a role this build has not been taught is not silently credited to either
 * party.
 */
export function messageAuthorFor(input: {
  readonly role: string;
  readonly messageId: string;
}): AdeRosterLastMessage["author"] {
  if (input.role === "assistant") return "bot";
  if (input.role !== "user") return "system";
  return isFleetInjectedMessageId(input.messageId) ? "system" : "captain";
}

/**
 * Squash a message body into one printable line.
 *
 * Newlines become spaces before truncation, not after: a message whose first
 * line is short would otherwise render as a preview with dead space and no
 * ellipsis, which reads as "that is the whole message" when it is not.
 *
 * ## The unit is UTF-16 code units, because that is what the contract checks
 *
 * `Schema.isMaxLength` measures `String.prototype.length`. Truncating to 160
 * *code points* therefore ships up to 320 code units for an emoji-dense
 * message, the frame fails to decode, and — because one roster frame carries
 * the whole fleet — a single astral character in one bot's last message takes
 * the entire rail's liveness down. So the budget below is code units, and the
 * only care needed is never to cut between a surrogate pair (which would emit a
 * lone surrogate, and is what makes naïve `slice` wrong here).
 *
 * A grapheme *cluster* at the boundary — a ZWJ family emoji, a flag, a combining
 * mark — can still be split, which renders as a partial glyph before the
 * ellipsis. Known cosmetic, deliberately not fixed: `Intl.Segmenter` for one
 * truncated character costs more than the artefact does, and the string is
 * always valid UTF-16 either way.
 */
export function toPreviewLine(text: string, limit = ADE_ROSTER_PREVIEW_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  // One unit is reserved for the ellipsis, which replaces the last character
  // rather than being appended — otherwise the result is `limit + 1` units.
  let end = limit - 1;
  const beforeEnd = collapsed.charCodeAt(end - 1);
  if (beforeEnd >= 0xd800 && beforeEnd <= 0xdbff) {
    // Cutting here would leave a high surrogate with nothing after it. Drop the
    // whole astral character instead of emitting half of one.
    end -= 1;
  }
  return `${collapsed.slice(0, end).trimEnd()}…`;
}

/**
 * Which open item the rail speaks for. An approval is the only kind anything is
 * *blocked* on (`adeNeedsYou.ts`), so it takes the line whenever one is open;
 * a `form` is next because the bot is idle until it is answered; the rest are
 * conditions that clear themselves and are reported newest-first.
 */
const ATTENTION_RANK: Readonly<Record<NeedsYouKind, number>> = {
  approval: 0,
  form: 1,
  stall: 2,
  "kernel-down": 3,
  "provision-failure": 4,
};

export const compareAttentionRows = (left: OpenAttentionRow, right: OpenAttentionRow): number =>
  ATTENTION_RANK[left.kind] - ATTENTION_RANK[right.kind];

/**
 * The amber line, from `kind` and an already-name-only title.
 *
 * The prefix is what makes the rail scannable — a captain reading eight rows
 * needs to know *an approval is waiting* before they read which bot it is —
 * and it is applied here rather than in the client so the mobile rail and the
 * web rail cannot drift into two vocabularies.
 */
export function attentionLineFor(row: OpenAttentionRow): AdeRosterAttention {
  const prefix =
    row.kind === "approval"
      ? "Approval required"
      : row.kind === "form"
        ? "Answer needed"
        : "Needs you";
  return { kind: row.kind, line: toPreviewLine(`${prefix}: ${row.title}`) };
}

export function resolveAttention(rows: ReadonlyArray<OpenAttentionRow>): AdeRosterAttention | null {
  if (rows.length === 0) return null;
  const [winner] = [...rows].sort(compareAttentionRows);
  return winner === undefined ? null : attentionLineFor(winner);
}

/**
 * Whether the rail may quote this bot's thread at all.
 *
 * A `form` item is a bot asking the captain for a value, and M5's
 * `SecureInputCard` is the rendering that asks for a secret one. The value
 * itself never enters the thread — it rides `ade.submitNeedsYouDecision` and is
 * forwarded, never persisted — but "the secret is not in the table we read" is
 * a claim about *another ticket's* implementation, and the roster preview is
 * not the place to depend on one. So while a form request is open the preview
 * is withheld outright: the attention line already says what to do, the tail of
 * that thread is precisely the exchange most likely to be carrying the answer,
 * and a line the rail never renders cannot leak.
 */
export const suppressesPreview = (rows: ReadonlyArray<OpenAttentionRow>): boolean =>
  rows.some((row) => row.kind === "form");

/**
 * Preview precedence (§4): approval > bot message > captain message > empty.
 *
 * The first term is the attention line, which the entry carries separately —
 * this returns the message half, and returns nothing at all when the bot is
 * mid-`form`. `null` is "the rail has no message to show", which the client
 * renders as the bot's home and open assignments rather than as a blank row.
 */
export function resolveLastMessage(input: {
  readonly rows: ReadonlyArray<LatestThreadMessageRow>;
  readonly attentionRows: ReadonlyArray<OpenAttentionRow>;
}): AdeRosterLastMessage | null {
  if (suppressesPreview(input.attentionRows)) {
    return null;
  }
  const [winner] = [...input.rows].sort(compareLatestMessageRows);
  if (winner === undefined) {
    return null;
  }
  const preview = toPreviewLine(winner.text);
  if (preview.length === 0) {
    // A message that is nothing but whitespace is not a preview. Reporting it
    // would print an empty dim line under the name and read as a rendering bug.
    return null;
  }
  return {
    preview,
    at: winner.created_at,
    author: messageAuthorFor({ role: winner.role, messageId: winner.message_id }),
  };
}

/** Clamp the unread count to what the badge can print. */
export const clampUnreadCount = (count: number): number =>
  count <= 0 ? 0 : Math.min(Math.trunc(count), ADE_UNREAD_DISPLAY_CAP);
