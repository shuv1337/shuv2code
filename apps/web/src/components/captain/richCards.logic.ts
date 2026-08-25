/**
 * Card selection for the captain messenger (MESSENGER-PIVOT §3, ticket M5).
 *
 * The pivot's closed card taxonomy is **work/PR, instruction, approval,
 * secure-input**. Three of the four are decided here, purely, from the same
 * `MessagesTimelineRow` union the IDE renders — there is no second parser for
 * message semantics, only a second *reading* of one. (The fourth, approval, is
 * a durable `NeedsYou` item rather than a row, so it is selected from the
 * needs-you list instead; see `SecureInputCard`.)
 *
 * Everything in this module is a detector: it answers "is this row already the
 * thing a card is for?" and returns `null` when it is not. Detection is
 * deliberately strict, for the same reason `parseAssignmentDeliveryText` is: a
 * bot that writes a sentence resembling a checklist must render as the sentence
 * it is. A missed card is a plain bubble; a false card is a lie about what the
 * bot said.
 */

import {
  parseAssignmentDeliveryArtifacts,
  type ParsedAssignmentArtifact,
  type ParsedAssignmentDelivery,
} from "../fleet/assignmentResult.logic";

// ---------------------------------------------------------------------------
// Work / PR card
// ---------------------------------------------------------------------------

/**
 * The publication-shaped artifacts a delivery carries, split by kind.
 *
 * `layers` is the captain's route to a diff: `onOpenTurnDiff` is a workspace
 * callback that `CaptainRowHost` stubs to a no-op, so in the messenger a
 * publication layer — not an expanded IDE row — is what a captain follows to
 * see what changed.
 */
export interface PrResultArtifacts {
  readonly layers: ReadonlyArray<Extract<ParsedAssignmentArtifact, { kind: "publicationLayer" }>>;
  readonly urls: ReadonlyArray<Extract<ParsedAssignmentArtifact, { kind: "url" }>>;
  readonly jjChanges: ReadonlyArray<Extract<ParsedAssignmentArtifact, { kind: "jjChange" }>>;
  readonly files: ReadonlyArray<Extract<ParsedAssignmentArtifact, { kind: "file" }>>;
}

const EMPTY_PR_RESULT_ARTIFACTS: PrResultArtifacts = {
  layers: [],
  urls: [],
  jjChanges: [],
  files: [],
};

/** Splits a delivery's flattened artifact lines back into typed buckets. */
export function resolvePrResultArtifacts(delivery: ParsedAssignmentDelivery): PrResultArtifacts {
  const artifacts = parseAssignmentDeliveryArtifacts(delivery);
  if (artifacts.length === 0) return EMPTY_PR_RESULT_ARTIFACTS;
  const layers: Array<Extract<ParsedAssignmentArtifact, { kind: "publicationLayer" }>> = [];
  const urls: Array<Extract<ParsedAssignmentArtifact, { kind: "url" }>> = [];
  const jjChanges: Array<Extract<ParsedAssignmentArtifact, { kind: "jjChange" }>> = [];
  const files: Array<Extract<ParsedAssignmentArtifact, { kind: "file" }>> = [];
  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "publicationLayer":
        layers.push(artifact);
        break;
      case "url":
        urls.push(artifact);
        break;
      case "jjChange":
        jjChanges.push(artifact);
        break;
      case "file":
        files.push(artifact);
        break;
    }
  }
  return { layers, urls, jjChanges, files };
}

/**
 * Whether a finished assignment produced something publishable.
 *
 * A publication layer or a URL is the whole test. A delivery whose only
 * artifacts are touched files or a bare jj change is *work*, not a
 * publication — it keeps the ordinary `AssignmentResultCard`, because promoting
 * it would offer a "View PR" action for a PR that does not exist.
 */
export function hasPublicationArtifacts(delivery: ParsedAssignmentDelivery): boolean {
  const artifacts = resolvePrResultArtifacts(delivery);
  return artifacts.layers.length > 0 || artifacts.urls.length > 0;
}

/**
 * The URL a *layer row* is allowed to link to, or `null`.
 *
 * A delivery's `url` artifacts are unattributed: the wire format is a flat
 * `- url https://…` line with nothing tying it to a particular layer. Handing
 * every row the same href produced a badge that *named* one PR and *opened*
 * another — the worst available outcome, because the badge reads as a label
 * for the destination.
 *
 * So a row links only when the URL is provably its own, which is exactly the
 * degenerate case: this delivery claimed one layer, one layer rendered, and one
 * URL was reported. Anything else and the rows render unlinked; the card-level
 * header still carries the primary link, where "some URL this delivery
 * reported" is an honest description of what it opens.
 */
export function resolvePrResultLayerUrl(input: {
  readonly artifacts: PrResultArtifacts;
  /** Layers actually drawn, after the stack read filtered to claimed ids. */
  readonly renderedLayerCount: number;
}): string | null {
  if (input.artifacts.layers.length !== 1) return null;
  if (input.renderedLayerCount !== 1) return null;
  if (input.artifacts.urls.length !== 1) return null;
  return input.artifacts.urls[0]?.href ?? null;
}

/**
 * The aggregate status a delivery reports, in worst-first precedence.
 *
 * A batch that mixes outcomes is not "completed": the captain reading one pill
 * needs the pill to name the thing that needs them, and a failure inside a
 * mostly-successful batch is that thing.
 */
export function resolveDeliveryStatus(
  delivery: ParsedAssignmentDelivery,
): "completed" | "failed" | "cancelled" {
  let sawCancelled = false;
  for (const assignment of delivery.assignments) {
    if (assignment.status === "failed") return "failed";
    if (assignment.status === "cancelled") sawCancelled = true;
  }
  return sawCancelled ? "cancelled" : "completed";
}

// ---------------------------------------------------------------------------
// Instruction card
// ---------------------------------------------------------------------------

export interface InstructionChecklistItem {
  readonly checked: boolean;
  /** Nesting level, clamped to 2 — deeper indentation is still an item. */
  readonly depth: number;
  /** The item body, as markdown, for `ChatMarkdown`. */
  readonly markdown: string;
}

export interface InstructionCardView {
  /** The line introducing the list ("Plan:", "## Steps"), when there is one. */
  readonly title: string | null;
  /** Everything before the list, minus the title line. */
  readonly leadMarkdown: string;
  readonly items: ReadonlyArray<InstructionChecklistItem>;
  /** Everything after the list. */
  readonly trailingMarkdown: string;
  readonly completedCount: number;
}

/** A GFM task-list line: `- [ ] …`, `* [x] …`, `1. [ ] …`. */
const TASK_LINE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s?(.*)$/;
const FENCE_LINE = /^\s*(?:```|~~~)/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+\S/;
/** CommonMark's *other* code block: four spaces (or a tab) after a blank line. */
const INDENTED_CODE_LINE = /^(?: {4}|\t)/;

/**
 * The smallest number of items that reads as a checklist. One checkbox in a
 * paragraph is a sentence with a box in it; two is a list the bot intends the
 * captain to track.
 */
const MIN_CHECKLIST_ITEMS = 2;

/**
 * Long enough for "Here is the plan for the parser rewrite:", short enough that
 * a paragraph cannot pass as a header.
 */
const MAX_TITLE_LENGTH = 60;

/**
 * Whether a line is the list's *header* — a short label naming what follows.
 *
 * Stealing a line out of the body and promoting it into the card's heading is
 * destructive: the line stops reading as prose and starts reading as a title,
 * and it is removed from the lead markdown either way. So the test is narrow.
 * A heading always qualifies. A colon-terminated line qualifies only when it is
 * short and carries no sentence punctuation before the colon — otherwise the
 * colon is introducing a clause inside a sentence ("I read the tests, they
 * fail, so here is what I will do:") rather than labelling a list, and hoisting
 * it decapitates the paragraph. When in doubt the line stays where the bot put
 * it and the card falls back to "Task list".
 */
function isTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return false;
  if (HEADING_LINE.test(line)) return true;
  if (!trimmed.endsWith(":")) return false;
  return !/[.!?;]/.test(trimmed.slice(0, -1));
}

/**
 * Reads a bot-authored task list out of a message, or returns `null`.
 *
 * Code-block-aware, in both of markdown's spellings: a checklist inside a
 * fenced block *or* inside a four-space indented block is sample text the bot
 * is *showing*, not a plan it is *keeping*, and repainting it as a live card
 * would claim the bot had committed to it. The indented spelling is the one
 * models reach for when quoting a snippet without a language tag, so leaving it
 * out left the fence rule half-enforced.
 *
 * The indent rule applies only *before* the list starts, which is what keeps it
 * from eating nested items: inside a list, four spaces is CommonMark
 * continuation, not a code block.
 *
 * Continuation lines (indented, non-task) fold into the item above them, so an
 * item with a second wrapped line keeps its whole body instead of losing the
 * tail to the trailing markdown.
 */
export function resolveInstructionCardView(text: string): InstructionCardView | null {
  const lines = text.split("\n");
  let fenced = false;
  let start = -1;
  let end = -1;
  const items: Array<{ checked: boolean; depth: number; parts: Array<string> }> = [];
  let pendingBlank = 0;
  let indentedCode = false;
  // A document's first line has a blank "line above" as far as block starts are
  // concerned, so an opening snippet is still recognized as a code block.
  let previousBlank = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      if (start !== -1) break;
      previousBlank = false;
      continue;
    }
    if (fenced) {
      if (start !== -1) break;
      continue;
    }

    if (start === -1) {
      const blank = line.trim().length === 0;
      if (indentedCode) {
        // The block runs until a non-blank line comes back out to the margin.
        if (!blank && !INDENTED_CODE_LINE.test(line)) indentedCode = false;
      } else if (previousBlank && !blank && INDENTED_CODE_LINE.test(line)) {
        indentedCode = true;
      }
      previousBlank = blank;
      if (indentedCode) continue;
    }

    const task = TASK_LINE.exec(line);
    if (task !== null) {
      if (start === -1) start = index;
      end = index;
      pendingBlank = 0;
      items.push({
        checked: (task[2] as string).toLowerCase() === "x",
        depth: Math.min(2, Math.floor((task[1] as string).replace(/\t/g, "  ").length / 2)),
        parts: [task[3] as string],
      });
      continue;
    }

    if (start === -1) continue;

    // Inside a run: blanks are held back — they only belong to the list if
    // another item follows, and otherwise end it.
    if (line.trim().length === 0) {
      pendingBlank += 1;
      continue;
    }
    const current = items[items.length - 1];
    if (pendingBlank === 0 && current !== undefined && /^\s{2,}\S/.test(line)) {
      current.parts.push(line.trim());
      end = index;
      continue;
    }
    break;
  }

  if (items.length < MIN_CHECKLIST_ITEMS || start === -1) return null;

  const before = lines.slice(0, start);
  let title: string | null = null;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const line = before[index] as string;
    if (line.trim().length === 0) continue;
    if (isTitleLine(line)) {
      title = line.replace(/^\s{0,3}#{1,6}\s+/, "").trim();
      before.splice(index, 1);
    }
    break;
  }

  return {
    title,
    leadMarkdown: before.join("\n").trim(),
    items: items.map((item) => ({
      checked: item.checked,
      depth: item.depth,
      markdown: item.parts.join("\n").trim(),
    })),
    trailingMarkdown: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
    completedCount: items.filter((item) => item.checked).length,
  };
}

// ---------------------------------------------------------------------------
// Secure input card
// ---------------------------------------------------------------------------

/**
 * Whether a Needs You item is answered by typing a value.
 *
 * This is `kind === "form"` and nothing else — no title/detail sniffing. The
 * product already treats `form` as *the* secret-bearing kind, and treats it
 * that way by construction rather than by guess: `suppressesPreview` in
 * `apps/server/src/ade/adeRosterLiveness.ts` withholds a bot's roster preview
 * entirely while a `form` item is open, and does so for `form` alone. That rule
 * only makes sense if a `form` answer is assumed to be a credential.
 *
 * So the card follows the invariant that already exists rather than inventing a
 * second, weaker one beside it. A regex over the server's one-line title would
 * be a heuristic that can be wrong in the direction that matters — a token in a
 * plaintext box — and would disagree with the suppression rule the moment the
 * two were worded differently.
 */
export function isSecureInputEntry(entry: { readonly item: { readonly kind: string } }): boolean {
  return entry.item.kind === "form";
}

/**
 * The field label a secure-input card shows.
 *
 * The title is the server's one-line "what is waiting"; a trailing colon reads
 * as a prompt for the box below it rather than as a heading, so it is dropped.
 */
export function resolveSecureInputFieldLabel(title: string): string {
  const trimmed = title.trim().replace(/:$/, "");
  return trimmed.length === 0 ? "Secret value" : trimmed;
}

/**
 * Whether the Save control is live.
 *
 * Empty is not submittable — an empty secret retires the item without answering
 * it, and the item is the only record that anything was ever asked.
 */
export function canSubmitSecureInput(input: {
  readonly value: string;
  readonly busy: boolean;
  readonly status: string;
}): boolean {
  return !input.busy && input.status === "open" && input.value.length > 0;
}
