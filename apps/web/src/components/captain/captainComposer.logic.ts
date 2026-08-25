import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import type { ComposerTurnDispatch } from "../chat/composerTurnDispatch";

/**
 * Pure decision logic for `CaptainComposer` (MESSENGER-PIVOT §3).
 *
 * The messenger composer is small, but three of its decisions are the ones a
 * captain notices when they are wrong: whether the thread is blocked and by
 * *what*, where a press should be routed, and which validation message is
 * allowed to survive a press. All three live here so they are pinned by tests
 * rather than by a rendered screenshot — the component only renders the result.
 */

export type CaptainComposerBlockedState =
  | {
      readonly kind: "approval";
      readonly approval: PendingApproval;
      readonly pendingCount: number;
    }
  | { readonly kind: "pending-user-input"; readonly pendingUserInput: PendingUserInput }
  | { readonly kind: "free" };

/**
 * What the composer is currently waiting on.
 *
 * An approval outranks a question: a durable grant is the thing that stops the
 * turn, and answering a question underneath it would not unblock anything.
 */
export function resolveCaptainComposerBlockedState(input: {
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
}): CaptainComposerBlockedState {
  const approval = input.pendingApprovals[0];
  if (approval !== undefined) {
    return { kind: "approval", approval, pendingCount: input.pendingApprovals.length };
  }
  const pendingUserInput = input.pendingUserInputs[0];
  if (pendingUserInput !== undefined) {
    return { kind: "pending-user-input", pendingUserInput };
  }
  return { kind: "free" };
}

/**
 * Where a press goes.
 *
 * A pending question does **not** disable the editor: the captain types the
 * answer into the same box they type everything else into, and the press is
 * routed at the answer instead of at a new turn. Only an approval — which has
 * no free-text form — takes the editor away.
 */
export function resolveCaptainComposerSubmissionTarget(
  blocked: CaptainComposerBlockedState,
): "provider-turn" | "pending-user-input" {
  return blocked.kind === "pending-user-input" ? "pending-user-input" : "provider-turn";
}

/** The editor is only inert while an approval is on screen. */
export function isCaptainComposerEditorDisabled(blocked: CaptainComposerBlockedState): boolean {
  return blocked.kind === "approval";
}

/**
 * The message a blocked dispatch must show.
 *
 * `null` means the dispatch may proceed. Returning it (rather than writing
 * state from inside the dispatch path) is what keeps validation single-writer:
 * the caller that presses is the only thing that sets the message, so a
 * synchronous "cannot steer this provider" cannot be overwritten by the press
 * result in the same batch.
 */
export function resolveCaptainDispatchValidationMessage(input: {
  readonly turnDispatch: ComposerTurnDispatch;
  readonly botName: string;
}): string | null {
  if (input.turnDispatch._tag !== "blocked") {
    return null;
  }
  // #217: state the state and the next action. The old copy narrated provider
  // internals ("this provider cannot steer it") and the app's own machinery
  // ("still synchronizing") at a captain who only wanted to send a message.
  return input.turnDispatch.reason === "turn-steering-unsupported"
    ? `${input.botName} is still working. Send this when it finishes.`
    : "Not connected yet. Try again in a moment.";
}

export type CaptainPendingUserInputAdvance =
  | { readonly _tag: "next-question"; readonly questionIndex: number }
  | {
      readonly _tag: "submit";
      readonly requestId: PendingUserInput["requestId"];
      readonly answers: Record<string, string | string[]>;
    }
  | { readonly _tag: "incomplete" };

/**
 * What "send" means while a question is open: step to the next question, or —
 * on the last one, with every answer resolved — submit the whole set.
 *
 * Mirrors `ChatView.onAdvanceActivePendingUserInput` exactly; the messenger
 * reaches the same durable item through the same shape rather than a second
 * decision path.
 */
export function resolveCaptainPendingUserInputAdvance(input: {
  readonly pendingUserInput: PendingUserInput;
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
}): CaptainPendingUserInputAdvance {
  const progress = derivePendingUserInputProgress(
    input.pendingUserInput.questions,
    input.answers,
    input.questionIndex,
  );
  if (!progress.isLastQuestion) {
    if (!progress.canAdvance) {
      return { _tag: "incomplete" };
    }
    return { _tag: "next-question", questionIndex: progress.questionIndex + 1 };
  }
  const answers = buildPendingUserInputAnswers(input.pendingUserInput.questions, input.answers);
  return answers === null
    ? { _tag: "incomplete" }
    : { _tag: "submit", requestId: input.pendingUserInput.requestId, answers };
}
