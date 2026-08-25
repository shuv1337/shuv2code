import { ApprovalRequestId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { submitComposerDraft } from "../chat/composerSubmission";
import {
  isCaptainComposerEditorDisabled,
  resolveCaptainComposerBlockedState,
  resolveCaptainComposerSubmissionTarget,
  resolveCaptainDispatchValidationMessage,
  resolveCaptainPendingUserInputAdvance,
} from "./captainComposer.logic";

const AT = "2026-03-17T19:12:28.000Z";

function approval(): PendingApproval {
  return {
    requestId: ApprovalRequestId.make("approval-1"),
    requestKind: "command",
    createdAt: AT,
    detail: "pnpm test",
  };
}

function question(input: {
  readonly id: string;
  readonly multiSelect?: boolean;
}): PendingUserInput["questions"][number] {
  return {
    id: input.id,
    header: "PICK ONE",
    question: `Which ${input.id}?`,
    multiSelect: input.multiSelect ?? false,
    options: [
      { label: "Retry", description: "Try again" },
      { label: "Skip", description: "Move on" },
    ],
  } as PendingUserInput["questions"][number];
}

function pendingUserInput(questions: PendingUserInput["questions"]): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("user-input-1"),
    createdAt: AT,
    questions,
  };
}

describe("resolveCaptainComposerBlockedState", () => {
  it("is free when nothing is pending", () => {
    expect(
      resolveCaptainComposerBlockedState({ pendingApprovals: [], pendingUserInputs: [] }),
    ).toEqual({ kind: "free" });
  });

  it("surfaces the first approval and how many are queued behind it", () => {
    const blocked = resolveCaptainComposerBlockedState({
      pendingApprovals: [approval(), approval()],
      pendingUserInputs: [pendingUserInput([question({ id: "q1" })])],
    });

    // An approval outranks a question: answering the question would not
    // unblock the turn the approval is holding.
    expect(blocked.kind).toBe("approval");
    if (blocked.kind !== "approval") throw new Error("unreachable");
    expect(blocked.pendingCount).toBe(2);
  });

  it("surfaces a pending question when no approval is waiting", () => {
    const blocked = resolveCaptainComposerBlockedState({
      pendingApprovals: [],
      pendingUserInputs: [pendingUserInput([question({ id: "q1" })])],
    });
    expect(blocked.kind).toBe("pending-user-input");
  });
});

describe("composer routing while blocked", () => {
  it("routes a press at the answer — and keeps the editor live — for a question", () => {
    const blocked = resolveCaptainComposerBlockedState({
      pendingApprovals: [],
      pendingUserInputs: [pendingUserInput([question({ id: "q1" })])],
    });

    expect(resolveCaptainComposerSubmissionTarget(blocked)).toBe("pending-user-input");
    // The regression this pins: the composer used to disable the editor here,
    // so a typed answer was impossible.
    expect(isCaptainComposerEditorDisabled(blocked)).toBe(false);
  });

  it("takes the editor away only for an approval, which has no free-text form", () => {
    const blocked = resolveCaptainComposerBlockedState({
      pendingApprovals: [approval()],
      pendingUserInputs: [],
    });

    expect(resolveCaptainComposerSubmissionTarget(blocked)).toBe("provider-turn");
    expect(isCaptainComposerEditorDisabled(blocked)).toBe(true);
  });
});

describe("resolveCaptainDispatchValidationMessage", () => {
  it("says so when the provider cannot steer a turn that is already running", () => {
    expect(
      resolveCaptainDispatchValidationMessage({
        turnDispatch: { _tag: "blocked", reason: "turn-steering-unsupported" },
        botName: "Code Monkey",
      }),
    ).toBe("Code Monkey is still working. Send this when it finishes.");
  });

  it("keeps provider internals out of the sentence (#217)", () => {
    const message = resolveCaptainDispatchValidationMessage({
      turnDispatch: { _tag: "blocked", reason: "turn-steering-unsupported" },
      botName: "Code Monkey",
    });
    expect(message).not.toContain("provider");
    expect(message).not.toContain("mid-turn");
  });

  it("distinguishes a not-yet-connected thread from an unsteerable one", () => {
    expect(
      resolveCaptainDispatchValidationMessage({
        turnDispatch: { _tag: "blocked", reason: "synchronizing" },
        botName: "Code Monkey",
      }),
    ).toBe("Not connected yet. Try again in a moment.");
    expect(
      resolveCaptainDispatchValidationMessage({
        turnDispatch: { _tag: "blocked", reason: "missing-active-turn" },
        botName: "Code Monkey",
      }),
    ).toBe("Not connected yet. Try again in a moment.");
  });

  it("stays silent when the turn can actually be dispatched", () => {
    expect(
      resolveCaptainDispatchValidationMessage({
        turnDispatch: { _tag: "start" },
        botName: "Code Monkey",
      }),
    ).toBeNull();
    expect(
      resolveCaptainDispatchValidationMessage({
        turnDispatch: { _tag: "steer", expectedTurnId: "turn-1" as never },
        botName: "Code Monkey",
      }),
    ).toBeNull();
  });
});

/**
 * The composition the composer performs on every press, reproduced exactly.
 *
 * The defect was here and nowhere else: `submitComposerDraft` returns
 * `validationMessage: null` for a draft of legal length, and writing *that*
 * after the dispatch path had already written its own message erased it in the
 * same batch — so Enter mid-turn on an unsteerable provider did nothing
 * visible. One writer, dispatch message first.
 */
function pressSubmit(input: {
  readonly prompt: string;
  readonly dispatchMessage: string | null;
}): string | null {
  const dispatchOutcome: { message: string | null } = { message: null };
  const outcome = submitComposerDraft({
    prompt: input.prompt,
    submissionTarget: "provider-turn",
    event: undefined,
    onSend: () => {
      if (input.dispatchMessage !== null) {
        dispatchOutcome.message = input.dispatchMessage;
        return false;
      }
      return;
    },
  });
  return dispatchOutcome.message ?? outcome.validationMessage;
}

describe("validation is single-writer", () => {
  it("keeps the dispatch-path message that the press itself has no complaint about", () => {
    expect(
      pressSubmit({
        prompt: "one more thing",
        dispatchMessage: "Code Monkey is mid-turn and this provider cannot steer it.",
      }),
    ).toBe("Code Monkey is mid-turn and this provider cannot steer it.");
  });

  it("reports nothing when the dispatch went through", () => {
    expect(pressSubmit({ prompt: "one more thing", dispatchMessage: null })).toBeNull();
  });

  it("still reports the length verdict, which is decided before dispatch is reached", () => {
    const message = pressSubmit({ prompt: "x".repeat(400_000), dispatchMessage: null });
    expect(message).not.toBeNull();
    expect(message).toContain("over the");
  });
});

describe("resolveCaptainPendingUserInputAdvance", () => {
  function withCustomAnswer(
    questionId: string,
    text: string,
  ): Record<string, PendingUserInputDraftAnswer> {
    return { [questionId]: setPendingUserInputCustomAnswer(undefined, text) };
  }

  it("submits a typed answer on the last question", () => {
    const prompt = pendingUserInput([question({ id: "q1" })]);
    const advance = resolveCaptainPendingUserInputAdvance({
      pendingUserInput: prompt,
      answers: withCustomAnswer("q1", "Neither — roll it back"),
      questionIndex: 0,
    });

    expect(advance).toEqual({
      _tag: "submit",
      requestId: prompt.requestId,
      answers: { q1: "Neither — roll it back" },
    });
  });

  it("submits a selected option on the last question", () => {
    const prompt = pendingUserInput([question({ id: "q1" })]);
    const advance = resolveCaptainPendingUserInputAdvance({
      pendingUserInput: prompt,
      answers: {
        q1: togglePendingUserInputOptionSelection(prompt.questions[0]!, undefined, "Retry"),
      },
      questionIndex: 0,
    });

    expect(advance).toEqual({
      _tag: "submit",
      requestId: prompt.requestId,
      answers: { q1: "Retry" },
    });
  });

  it("steps to the next question rather than submitting a half-answered set", () => {
    const prompt = pendingUserInput([question({ id: "q1" }), question({ id: "q2" })]);
    expect(
      resolveCaptainPendingUserInputAdvance({
        pendingUserInput: prompt,
        answers: withCustomAnswer("q1", "Retry"),
        questionIndex: 0,
      }),
    ).toEqual({ _tag: "next-question", questionIndex: 1 });
  });

  it("refuses to advance or submit while the active question is unanswered", () => {
    const prompt = pendingUserInput([question({ id: "q1" }), question({ id: "q2" })]);
    expect(
      resolveCaptainPendingUserInputAdvance({
        pendingUserInput: prompt,
        answers: {},
        questionIndex: 0,
      })._tag,
    ).toBe("incomplete");
    expect(
      resolveCaptainPendingUserInputAdvance({
        pendingUserInput: prompt,
        answers: withCustomAnswer("q1", "Retry"),
        questionIndex: 1,
      })._tag,
    ).toBe("incomplete");
  });

  it("submits every selected label for a multi-select question", () => {
    const prompt = pendingUserInput([question({ id: "q1", multiSelect: true })]);
    const first = togglePendingUserInputOptionSelection(prompt.questions[0]!, undefined, "Retry");
    const both = togglePendingUserInputOptionSelection(prompt.questions[0]!, first, "Skip");
    expect(
      resolveCaptainPendingUserInputAdvance({
        pendingUserInput: prompt,
        answers: { q1: both },
        questionIndex: 0,
      }),
    ).toEqual({
      _tag: "submit",
      requestId: prompt.requestId,
      answers: { q1: ["Retry", "Skip"] },
    });
  });
});
