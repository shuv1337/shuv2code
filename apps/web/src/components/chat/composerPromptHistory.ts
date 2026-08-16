import type { ChatMessage } from "../../types";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { parseReviewCommentMessageSegments } from "../../reviewCommentContext";

export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
export const FILE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached file(s).]";

export type PromptHistoryDirection = "older" | "newer";

export type PromptHistoryStep =
  | { kind: "entry"; index: number }
  | { kind: "draft" }
  | { kind: "boundary" };

export interface ComposerPromptHistoryBrowseState<Target> {
  target: Target;
  index: number;
  draft: string;
  recalledValue: string;
}

export type ComposerPromptHistoryBrowseReconciliation = "keep" | "discard" | "restore";

export interface ComposerPromptHistoryEligibility {
  direction: PromptHistoryDirection;
  value: string;
  cursor: number;
  isVisualEdge: boolean;
  isMobileViewport: boolean;
  hasModifier: boolean;
  isComposing: boolean;
  keyCode: number;
  isBlocked: boolean;
  hasTerminalContexts: boolean;
  hasActiveTrigger: boolean;
  hasActiveBrowse: boolean;
  isSelectionCollapsed: boolean;
}

export function canBrowseComposerPromptHistory({
  direction,
  value,
  cursor,
  isVisualEdge,
  isMobileViewport,
  hasModifier,
  isComposing,
  keyCode,
  isBlocked,
  hasTerminalContexts,
  hasActiveTrigger,
  hasActiveBrowse,
  isSelectionCollapsed,
}: ComposerPromptHistoryEligibility): boolean {
  if (
    isMobileViewport ||
    hasModifier ||
    isComposing ||
    keyCode === 229 ||
    isBlocked ||
    hasTerminalContexts ||
    (!hasActiveBrowse && hasActiveTrigger) ||
    !isSelectionCollapsed
  ) {
    return false;
  }

  const isLogicalEdge =
    direction === "older"
      ? value.lastIndexOf("\n", Math.max(0, cursor - 1)) < 0
      : value.indexOf("\n", cursor) < 0;

  return isLogicalEdge && isVisualEdge;
}

export function reconcileComposerPromptHistoryBrowse<Target>(
  browse: ComposerPromptHistoryBrowseState<Target>,
  currentTarget: Target,
  currentValue: string,
  entries: ReadonlyArray<string>,
): ComposerPromptHistoryBrowseReconciliation {
  if (browse.target !== currentTarget) return "restore";
  if (!isComposerPromptHistoryPositionValid(entries, browse.index, browse.recalledValue)) {
    return "restore";
  }
  return currentValue === browse.recalledValue ? "keep" : "discard";
}

export function isComposerPromptHistoryBlankHardEdge(
  value: string,
  cursor: number,
  direction: PromptHistoryDirection,
): boolean {
  return direction === "older"
    ? cursor === 0 && value.startsWith("\n")
    : cursor === value.length && value.endsWith("\n");
}

export function projectComposerPromptHistory(
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<string> {
  const entries: string[] = [];

  for (const message of messages) {
    if (message.role !== "user") continue;

    let prompt = parseReviewCommentMessageSegments(message.text)
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.text)
      .join("");

    while (true) {
      const extracted = extractTrailingPreviewAnnotation(prompt);
      if (!extracted.annotation) break;
      prompt = extracted.promptText;
    }

    prompt = deriveDisplayedUserMessageState(prompt).visibleText.trim();
    const isAttachmentFallback =
      prompt === IMAGE_ONLY_BOOTSTRAP_PROMPT || prompt === FILE_ONLY_BOOTSTRAP_PROMPT;
    const isPrefixedAttachmentFallback =
      (message.attachments?.length ?? 0) > 0 &&
      (prompt === `Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}` ||
        prompt === `Ultrathink:\n${FILE_ONLY_BOOTSTRAP_PROMPT}`);
    if (!prompt || isAttachmentFallback || isPrefixedAttachmentFallback) continue;
    if (entries.at(-1) !== prompt) entries.push(prompt);
  }

  return entries;
}

export function stepComposerPromptHistory(
  entries: ReadonlyArray<string>,
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryStep {
  if (direction === "older") {
    if (entries.length === 0 || currentIndex === 0) return { kind: "boundary" };
    if (currentIndex !== null && (currentIndex < 0 || currentIndex >= entries.length)) {
      return { kind: "draft" };
    }
    return { kind: "entry", index: currentIndex === null ? entries.length - 1 : currentIndex - 1 };
  }

  if (currentIndex === null) return { kind: "boundary" };
  if (currentIndex < 0 || currentIndex >= entries.length - 1) return { kind: "draft" };
  return { kind: "entry", index: currentIndex + 1 };
}

export function isComposerPromptHistoryPositionValid(
  entries: ReadonlyArray<string>,
  index: number,
  recalledValue: string,
): boolean {
  return entries[index] === recalledValue;
}
