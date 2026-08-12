import type { OrchestrationMessage } from "@shuv2code/contracts";

export interface ProviderContinuityInputResult {
  readonly text: string;
  readonly includedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

export interface BuildProviderContinuityInput {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly latestUserRequest: string;
  readonly maxChars: number;
}

const CONTINUITY_PREAMBLE =
  "Continue this conversation using the canonical shuv2code transcript context below. The provider session was replaced, but the shuv2code thread, workspace, and timeline are unchanged. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_REQUEST_HEADER = "Latest user request (answer this now):";
const omittedSummary = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function attachmentSummary(message: OrchestrationMessage): string | null {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return null;
  }

  const names = attachments.slice(0, 3).map((attachment) => attachment.name);
  const extraCount = attachments.length - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached file${attachments.length === 1 ? "" : "s"}: ${names.join(", ")}${extraSummary}]`;
}

function messageBlock(message: OrchestrationMessage): string {
  const role = message.role === "assistant" ? "ASSISTANT" : "USER";
  const attachments = attachmentSummary(message);
  const body =
    message.text.length > 0 && attachments !== null
      ? `${message.text}\n${attachments}`
      : message.text.length > 0
        ? message.text
        : (attachments ?? "(empty message)");
  return `${role}:\n${body}`;
}

function finalize(
  transcriptBody: string,
  latestUserRequest: string,
  maxChars: number,
): string | null {
  const text = `${CONTINUITY_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_REQUEST_HEADER}\n${latestUserRequest}`;
  return text.length <= maxChars ? text : null;
}

export function buildProviderContinuityInput(
  input: BuildProviderContinuityInput,
): ProviderContinuityInputResult {
  const budget = Number.isFinite(input.maxChars) ? Math.max(1, Math.floor(input.maxChars)) : 1;
  const promptOnly = input.latestUserRequest.slice(0, budget);
  const eligibleMessages = input.messages.filter(
    (message) => message.role !== "system" && message.streaming === false,
  );

  if (eligibleMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== input.latestUserRequest.length,
    };
  }

  const newestFirstBlocks = eligibleMessages.toReversed().map(messageBlock);
  let includedNewestFirst: Array<string> = [];

  for (const block of newestFirstBlocks) {
    const candidateNewestFirst = [...includedNewestFirst, block];
    const candidateChronological = candidateNewestFirst.toReversed();
    const omittedCount = newestFirstBlocks.length - candidateChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? `${omittedSummary(omittedCount)}\n\n${candidateChronological.join("\n\n")}`
        : candidateChronological.join("\n\n");
    if (finalize(transcriptBody, input.latestUserRequest, budget) === null) {
      break;
    }
    includedNewestFirst = candidateNewestFirst;
  }

  let includedChronological = includedNewestFirst.toReversed();
  while (true) {
    const omittedCount = newestFirstBlocks.length - includedChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? includedChronological.length > 0
          ? `${omittedSummary(omittedCount)}\n\n${includedChronological.join("\n\n")}`
          : omittedSummary(omittedCount)
        : includedChronological.join("\n\n");
    const finalized = finalize(transcriptBody, input.latestUserRequest, budget);
    if (finalized !== null) {
      return {
        text: finalized,
        includedCount: includedChronological.length,
        omittedCount,
        truncated: omittedCount > 0 || promptOnly.length !== input.latestUserRequest.length,
      };
    }

    if (includedChronological.length === 0) {
      return {
        text: promptOnly,
        includedCount: 0,
        omittedCount: eligibleMessages.length,
        truncated: true,
      };
    }

    includedChronological = includedChronological.slice(1);
  }
}
