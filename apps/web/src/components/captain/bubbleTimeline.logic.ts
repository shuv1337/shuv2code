import type { TurnId } from "@shuv2code/contracts";

import {
  classifyBubbleRow,
  normalizeCompactToolLabel,
  type MessagesTimelineRow,
} from "../chat/MessagesTimeline.logic";
import {
  parseAssignmentDeliveryText,
  type ParsedAssignmentDelivery,
} from "../fleet/assignmentResult.logic";
import {
  hasPublicationArtifacts,
  resolveInstructionCardView,
  type InstructionCardView,
} from "./richCards.logic";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import {
  selectUserMessageFiles,
  selectUserMessageImages,
  selectUserMessagePreviewAnnotationImages,
  type UserMessageAttachment,
} from "../chat/userMessageAttachments.logic";

/**
 * The captain messenger's projection of the IDE timeline (MESSENGER-PIVOT §1,
 * §3). Everything here is pure so the fold rules and the bubble/trace split are
 * testable without a DOM: `BubbleTimeline` does nothing but render the items
 * this module produces.
 *
 * The input is the *same* `MessagesTimelineRow[]` the IDE renders — there is no
 * second parser for message semantics. This module only decides which lane a
 * row lands in and which rows fold together.
 */

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;
type WorkingRow = Extract<MessagesTimelineRow, { kind: "working" }>;

/** Where a bubble sits inside a run of consecutive same-author bubbles. */
export type BubbleGroupPosition = "single" | "first" | "middle" | "last";

export type BubbleTimelineItem =
  | {
      readonly kind: "day-divider";
      readonly id: string;
      /** Local calendar day, `YYYY-MM-DD`. */
      readonly dayKey: string;
      readonly at: string;
    }
  | {
      readonly kind: "bubble";
      readonly id: string;
      readonly row: MessageRow;
      readonly author: "captain" | "bot";
      readonly groupPosition: BubbleGroupPosition;
      /** Bot bubbles carry the avatar only on the last bubble of a run. */
      readonly showAvatar: boolean;
    }
  | {
      readonly kind: "assignment-result";
      readonly id: string;
      readonly row: MessageRow;
      readonly delivery: ParsedAssignmentDelivery;
    }
  /**
   * A finished assignment that published something (M5). The same row and the
   * same delivery as `assignment-result` — a different *card*, chosen because
   * this delivery reported a publication layer or a URL.
   */
  | {
      readonly kind: "pr-result";
      readonly id: string;
      readonly row: MessageRow;
      readonly delivery: ParsedAssignmentDelivery;
    }
  /** A bot-authored task list (M5). */
  | {
      readonly kind: "instruction";
      readonly id: string;
      readonly row: MessageRow;
      readonly view: InstructionCardView;
    }
  | {
      readonly kind: "attribution";
      readonly id: string;
      readonly at: string;
      readonly label: string;
      /** Recipient bot ids in first-seen order, deduplicated. */
      readonly botIds: ReadonlyArray<string>;
      readonly messageCount: number;
      /** The folded rows, so expanding shows the real cards. */
      readonly rows: ReadonlyArray<MessageRow>;
    }
  | { readonly kind: "trace"; readonly id: string; readonly row: MessagesTimelineRow }
  | { readonly kind: "working"; readonly id: string; readonly row: WorkingRow };

/**
 * Local calendar day for a timestamp. Local, not UTC: a day divider that
 * disagrees with the captain's wall clock is worse than no divider.
 */
export function resolveBubbleDayKey(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * "2 messages with Code Monkey". Names are already roster-resolved; an
 * unresolved bot keeps its id rather than vanishing from the line.
 */
export function formatAttributionLabel(
  messageCount: number,
  botNames: ReadonlyArray<string>,
): string {
  const noun = messageCount === 1 ? "message" : "messages";
  const [first, second] = botNames;
  if (first === undefined) {
    return `${messageCount} ${noun} with a sub-agent`;
  }
  if (second === undefined) {
    return `${messageCount} ${noun} with ${first}`;
  }
  if (botNames.length === 2) {
    return `${messageCount} ${noun} with ${first} and ${second}`;
  }
  const others = botNames.length - 1;
  return `${messageCount} ${noun} with ${first} and ${others} others`;
}

function isAssignmentDeliveryRow(row: MessagesTimelineRow): ParsedAssignmentDelivery | null {
  if (row.kind !== "message" || row.message.role !== "user") {
    return null;
  }
  return parseAssignmentDeliveryText(row.message.text ?? "");
}

/**
 * The instruction card's view for a row, or null.
 *
 * Bot-authored only. A captain who types a checklist is writing a *request*,
 * not reporting progress, and repainting their own message as a tracked list
 * would claim the fleet had accepted it.
 */
function instructionViewFor(
  row: MessageRow,
  author: "captain" | "bot",
): InstructionCardView | null {
  if (author !== "bot") return null;
  const text = row.message.text;
  if (text === null || text === undefined) return null;
  return resolveInstructionCardView(text);
}

function bubbleAuthor(row: MessageRow): "captain" | "bot" {
  return row.message.role === "user" ? "captain" : "bot";
}

function groupPositionFor(isFirst: boolean, isLast: boolean): BubbleGroupPosition {
  if (isFirst && isLast) return "single";
  if (isFirst) return "first";
  if (isLast) return "last";
  return "middle";
}

/**
 * Projects IDE rows into messenger items.
 *
 * Three folds, in this order:
 * 1. **Sub-agent traffic.** A run of consecutive assignment-delivery user turns
 *    (spec §13.5 synthetic input) longer than one collapses into a single
 *    `attribution` line. A lone delivery keeps its `AssignmentResultCard`,
 *    because one finished assignment is news, not noise.
 * 2. **Day dividers**, emitted whenever the local calendar day changes.
 * 3. **Bubble runs**, so consecutive same-author bubbles can share one avatar
 *    and one set of outer corners.
 *
 * Everything `classifyBubbleRow` calls a trace is emitted verbatim as a `trace`
 * item; nothing is ever dropped, so an unknown future row kind still appears.
 */
export function buildBubbleTimelineItems(input: {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  /** Roster projection: bot id → display name. */
  readonly botNameById?: ReadonlyMap<string, string> | undefined;
}): Array<BubbleTimelineItem> {
  const botNameById = input.botNameById ?? new Map<string, string>();
  const items: Array<BubbleTimelineItem> = [];
  let lastDayKey: string | null = null;

  const emitDayDivider = (at: string | null) => {
    if (at === null) return;
    const dayKey = resolveBubbleDayKey(at);
    if (dayKey === null || dayKey === lastDayKey) return;
    lastDayKey = dayKey;
    items.push({ kind: "day-divider", id: `day:${dayKey}`, dayKey, at });
  };

  const rows = input.rows;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as MessagesTimelineRow;

    // 1. Sub-agent traffic.
    const delivery = isAssignmentDeliveryRow(row);
    if (delivery !== null) {
      const runRows: Array<MessageRow> = [];
      const deliveries: Array<ParsedAssignmentDelivery> = [];
      let cursor = index;
      while (cursor < rows.length) {
        const candidate = rows[cursor] as MessagesTimelineRow;
        const parsed = isAssignmentDeliveryRow(candidate);
        if (parsed === null) break;
        runRows.push(candidate as MessageRow);
        deliveries.push(parsed);
        cursor += 1;
      }
      emitDayDivider(row.createdAt);
      const firstRow = runRows[0] as MessageRow;
      if (runRows.length === 1) {
        const only = deliveries[0] as ParsedAssignmentDelivery;
        // The work/PR card wins over the plain result card when — and only
        // when — the delivery named something publishable. A delivery whose
        // artifacts are touched files is *work*, not a publication, and
        // promoting it would offer a "View PR" for a PR that does not exist.
        items.push({
          kind: hasPublicationArtifacts(only) ? "pr-result" : "assignment-result",
          id: firstRow.id,
          row: firstRow,
          delivery: only,
        });
      } else {
        const botIds: Array<string> = [];
        for (const parsed of deliveries) {
          for (const assignment of parsed.assignments) {
            if (!botIds.includes(assignment.recipientBotId)) {
              botIds.push(assignment.recipientBotId);
            }
          }
        }
        items.push({
          kind: "attribution",
          id: `attribution:${firstRow.id}`,
          at: firstRow.createdAt,
          label: formatAttributionLabel(
            runRows.length,
            botIds.map((botId) => botNameById.get(botId) ?? botId),
          ),
          botIds,
          messageCount: runRows.length,
          rows: runRows,
        });
      }
      index = cursor;
      continue;
    }

    if (row.kind === "working") {
      emitDayDivider(row.createdAt);
      items.push({ kind: "working", id: row.id, row });
      index += 1;
      continue;
    }

    if (classifyBubbleRow(row) === "trace") {
      emitDayDivider(row.createdAt);
      items.push({ kind: "trace", id: row.id, row });
      index += 1;
      continue;
    }

    // 3. Bubble run — same author, unbroken, same calendar day.
    const messageRow = row as MessageRow;
    const author = bubbleAuthor(messageRow);
    const runRows: Array<MessageRow> = [];
    let cursor = index;
    while (cursor < rows.length) {
      const candidate = rows[cursor] as MessagesTimelineRow;
      if (candidate.kind !== "message") break;
      if (isAssignmentDeliveryRow(candidate) !== null) break;
      if (classifyBubbleRow(candidate) !== "bubble") break;
      const candidateRow = candidate as MessageRow;
      if (bubbleAuthor(candidateRow) !== author) break;
      if (resolveBubbleDayKey(candidateRow.createdAt) !== resolveBubbleDayKey(messageRow.createdAt))
        break;
      runRows.push(candidateRow);
      cursor += 1;
    }
    emitDayDivider(messageRow.createdAt);
    runRows.forEach((runRow, runIndex) => {
      // A bot's task list becomes a card rather than a bubble, and does so
      // *inside* the run: a plan is usually one message in the middle of a
      // paragraph of them, and breaking the run to hoist it would reorder the
      // conversation. The neighbours keep their run geometry; only this item's
      // rendering changes.
      const instruction = instructionViewFor(runRow, author);
      if (instruction !== null) {
        items.push({ kind: "instruction", id: runRow.id, row: runRow, view: instruction });
        return;
      }
      const isFirst = runIndex === 0;
      const isLast = runIndex === runRows.length - 1;
      items.push({
        kind: "bubble",
        id: runRow.id,
        row: runRow,
        author,
        groupPosition: groupPositionFor(isFirst, isLast),
        // The avatar hangs off the *last* bubble so it sits beside the newest
        // line of a run rather than floating at the top of a tall block.
        showAvatar: author === "bot" && isLast,
      });
    });
    index = cursor;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Disclosure anchoring
// ---------------------------------------------------------------------------

/**
 * The anchor key for a turn-fold toggle.
 *
 * `deriveMessagesTimelineRows` mints `turn-fold:<foldId>` as the row id, and a
 * trace item carries the row id verbatim — so this is what
 * `shouldRestoreBubblePosition` will be asked about when that fold is toggled.
 * The IDE timeline uses the identical key; keeping them equal is what lets the
 * shared `onToggleTurnFold` callback anchor correctly on both surfaces.
 */
export function resolveTurnFoldAnchorKey(foldId: string): string {
  return `turn-fold:${foldId}`;
}

/**
 * Whether LegendList should restore this item's position after a size change.
 *
 * While a disclosure is settling, only the *toggled* row is anchored: anchoring
 * every row would fight the growth the toggle just caused. With no toggle in
 * flight (`anchorKey === null`) every row anchors, which is the ordinary
 * "content above me changed height" case.
 */
export function shouldRestoreBubblePosition(anchorKey: string | null, itemId: string): boolean {
  return anchorKey === null || itemId === anchorKey;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface BubbleTimelineActivity {
  readonly isWorking: boolean;
  readonly activeTurnInProgress: boolean;
  readonly latestTurnId: TurnId | null;
  readonly workingStepLabel: string | null;
}

/**
 * The activity an expanded IDE row is mounted with.
 *
 * Not cosmetic: `activeTurnInProgress` is how a row decides whether the work it
 * describes is still running, and `latestTurnId` gates the changed-files
 * behaviour. Hard-coding them to `false` / `null` — which the first cut did —
 * painted in-flight tool calls with success chrome, so a captain watching a bot
 * work saw it finish things it had not finished.
 */
export function resolveBubbleTimelineActivity(input: {
  readonly isWorking: boolean;
  readonly latestTurn: { readonly turnId: TurnId; readonly state: string } | null;
}): BubbleTimelineActivity {
  return {
    isWorking: input.isWorking,
    activeTurnInProgress: input.latestTurn?.state === "running",
    latestTurnId: input.latestTurn?.turnId ?? null,
    workingStepLabel: null,
  };
}

// ---------------------------------------------------------------------------
// Bubble contents
// ---------------------------------------------------------------------------

export interface BubbleMessageDisplay {
  /** What the bubble draws: trailer markup already stripped. */
  readonly text: string;
  /** What the copy button yields: the message exactly as it was sent. */
  readonly copyText: string;
  readonly images: ReadonlyArray<UserMessageAttachment>;
  readonly files: ReadonlyArray<UserMessageAttachment>;
  /** False for a message with neither text nor attachments — never rendered. */
  readonly hasContent: boolean;
}

/**
 * What one bubble actually shows.
 *
 * A captain message carries send-time trailers — `<terminal_context>`,
 * `<element_context>`, and preview-annotation blocks — appended after the typed
 * line. The IDE row has always stripped them; a bubble that printed
 * `row.message.text` verbatim leaked that markup into the conversation. It also
 * dropped attachments entirely, so an image-only message rendered as an empty
 * bubble.
 *
 * Both are the same omission: a bubble is not "the text field of a message", it
 * is the message. This runs the *same* derivation `UserTimelineRow` runs, and
 * hands back the attachments alongside it.
 */
export function resolveBubbleMessageDisplay(row: MessageRow): BubbleMessageDisplay {
  const rawText = row.message.text ?? "";
  const attachments = (row.message.attachments ?? []) as ReadonlyArray<UserMessageAttachment>;
  // Preview-annotation crops are folded in with the ordinary images: the
  // messenger has no annotation card, and showing the crop beats dropping it.
  const images = [
    ...selectUserMessageImages(attachments),
    ...selectUserMessagePreviewAnnotationImages(attachments),
  ];
  const files = selectUserMessageFiles(attachments);

  if (row.message.role !== "user") {
    return {
      text: rawText,
      copyText: rawText,
      images,
      files,
      hasContent: rawText.trim().length > 0 || images.length > 0 || files.length > 0,
    };
  }

  const displayed = deriveDisplayedUserMessageState(rawText);
  let visibleText = displayed.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    visibleText = extracted.promptText;
  }
  const text = extractTrailingElementContexts(visibleText).promptText;
  return {
    text,
    copyText: displayed.copyText,
    images,
    files,
    hasContent: text.trim().length > 0 || images.length > 0 || files.length > 0,
  };
}

// ---------------------------------------------------------------------------
// TraceCard summary
// ---------------------------------------------------------------------------

export interface TraceCardSummary {
  /** Already normalized for display; never the raw "… completed" phrasing. */
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error" | "plan";
  /** Wall time the trace covers, when the rows carry both ends. */
  readonly durationMs: number | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  /** Extra rows hidden behind the collapsed line, for "+3 more". */
  readonly hiddenCount: number;
}

function elapsedMs(from: string, to: string): number | null {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return end - start;
}

/**
 * The changed-line totals for a row's turn, or null when the row has none.
 *
 * The summary is per *assistant message*, which is why a captain turn and a
 * synthetic assignment delivery both answer null: the work they describe
 * happened somewhere this thread's checkpoints do not reach.
 */
export function resolveRowDiffStat(
  row: MessagesTimelineRow,
): { readonly additions: number; readonly deletions: number } | null {
  if (row.kind !== "message") return null;
  const summary = row.assistantTurnDiffSummary;
  if (summary === undefined) return null;
  return summary.files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

/**
 * The collapsed one-liner for a trace row (MESSENGER-PIVOT §3). Pure so the
 * label normalization and the duration/diff arithmetic are pinned by tests
 * rather than read off a rendered card.
 */
export function resolveTraceCardSummary(row: MessagesTimelineRow): TraceCardSummary {
  switch (row.kind) {
    case "work": {
      const entries = row.groupedEntries;
      const first = entries[0];
      const last = entries[entries.length - 1];
      const label =
        first === undefined ? "Work" : normalizeCompactToolLabel(first.toolTitle ?? first.label);
      return {
        label: label.length === 0 ? "Work" : label,
        tone: first?.tone ?? "tool",
        durationMs:
          first === undefined || last === undefined || first === last
            ? null
            : elapsedMs(first.createdAt, last.createdAt),
        diffStat: null,
        hiddenCount: Math.max(0, entries.length - 1),
      };
    }
    case "work-toggle":
      return {
        label: row.expanded
          ? "Hide steps"
          : `${row.hiddenCount} more ${row.onlyToolEntries ? "tool call" : "step"}${row.hiddenCount === 1 ? "" : "s"}`,
        tone: "info",
        durationMs: null,
        diffStat: null,
        hiddenCount: row.hiddenCount,
      };
    case "turn-fold":
      return {
        label: normalizeCompactToolLabel(row.label) || "Turn",
        tone: "info",
        durationMs: null,
        diffStat: null,
        hiddenCount: row.images.length,
      };
    case "proposed-plan":
      return { label: "Plan", tone: "plan", durationMs: null, diffStat: null, hiddenCount: 0 };
    case "turn-plan":
      return { label: "Plan", tone: "plan", durationMs: null, diffStat: null, hiddenCount: 0 };
    case "message": {
      const diffStat = resolveRowDiffStat(row);
      return {
        label: row.message.role === "system" ? "System message" : "Message",
        tone: row.message.role === "system" ? "info" : "tool",
        durationMs: elapsedMs(row.durationStart, row.message.updatedAt),
        diffStat,
        hiddenCount: 0,
      };
    }
    default:
      // Unknown future row kinds still get a card, never a blank line.
      return { label: "Activity", tone: "info", durationMs: null, diffStat: null, hiddenCount: 0 };
  }
}

/** `1.2s` / `340ms` / `2m 05s` — short enough for a collapsed one-liner. */
export function formatTraceDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${`${seconds}`.padStart(2, "0")}s`;
}
