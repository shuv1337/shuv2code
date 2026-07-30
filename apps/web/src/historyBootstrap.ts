import type { ChatMessage } from "./types";

export interface BootstrapInputResult {
  text: string;
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
}

export interface BootstrapWorkObserver {
  readonly onMessageBlockBuilt?: () => void;
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function messageRoleLabel(message: ChatMessage): "USER" | "ASSISTANT" {
  return message.role === "assistant" ? "ASSISTANT" : "USER";
}

function attachmentSummary(message: ChatMessage): string | null {
  const imageAttachments = message.attachments?.filter((attachment) => attachment.type === "image");
  const count = imageAttachments?.length ?? 0;
  if (count === 0) {
    return null;
  }

  const names = imageAttachments?.slice(0, 3).map((image) => image.name) ?? [];
  const namesSummary = names.join(", ");
  const extraCount = count - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached image${count === 1 ? "" : "s"}: ${namesSummary}${extraSummary}]`;
}

function buildMessageBlock(message: ChatMessage): string {
  const text = message.text;
  const attachments = attachmentSummary(message);

  if (text && attachments) {
    return `${messageRoleLabel(message)}:\n${text}\n${attachments}`;
  }
  if (text) {
    return `${messageRoleLabel(message)}:\n${text}`;
  }
  if (attachments) {
    return `${messageRoleLabel(message)}:\n${attachments}`;
  }
  return `${messageRoleLabel(message)}:\n(empty message)`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

export function buildBootstrapInput(
  previousMessages: ChatMessage[],
  latestPrompt: string,
  maxChars: number,
  workObserver?: BootstrapWorkObserver,
): BootstrapInputResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }

  const includedNewestFirst: string[] = [];
  let includedBodyLength = 0;
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (!message) continue;
    workObserver?.onMessageBlockBuilt?.();
    const block = buildMessageBlock(message);
    const nextIncludedCount = includedNewestFirst.length + 1;
    const nextBodyLength = includedBodyLength + block.length + (nextIncludedCount > 1 ? 2 : 0);
    const omittedCount = previousMessages.length - nextIncludedCount;
    const omittedPrefixLength = omittedCount > 0 ? OMITTED_SUMMARY(omittedCount).length + 2 : 0;
    const finalLength =
      BOOTSTRAP_PREAMBLE.length +
      2 +
      TRANSCRIPT_HEADER.length +
      1 +
      omittedPrefixLength +
      nextBodyLength +
      2 +
      LATEST_PROMPT_HEADER.length +
      1 +
      latestPrompt.length;
    if (finalLength > budget) {
      break;
    }
    includedNewestFirst.push(block);
    includedBodyLength = nextBodyLength;
  }

  const includedChronological = includedNewestFirst.toReversed();
  const omittedCount = previousMessages.length - includedChronological.length;
  const transcriptBody =
    omittedCount > 0
      ? includedChronological.length > 0
        ? `${OMITTED_SUMMARY(omittedCount)}\n\n${includedChronological.join("\n\n")}`
        : OMITTED_SUMMARY(omittedCount)
      : includedChronological.join("\n\n");
  const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
  if (finalized) {
    return {
      text: finalized,
      includedCount: includedChronological.length,
      omittedCount,
      truncated: omittedCount > 0 || latestPrompt.length !== promptOnly.length,
    };
  }
  return {
    text: promptOnly,
    includedCount: 0,
    omittedCount: previousMessages.length,
    truncated: true,
  };
}
