import type {
  ApprovalRequestId,
  EnvironmentId,
  ProviderApprovalDecision,
  ScopedThreadRef,
} from "@shuv2code/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { newMessageId } from "../../lib/utils";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import type { EnvironmentThread } from "@shuv2code/client-runtime/state/models";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import {
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "../chat/composerSubmission";
import {
  resolveComposerTurnDispatch,
  type ComposerTurnDispatch,
} from "../chat/composerTurnDispatch";
import { Button } from "../ui/button";
import {
  isCaptainComposerEditorDisabled,
  resolveCaptainComposerBlockedState,
  resolveCaptainComposerSubmissionTarget,
  resolveCaptainDispatchValidationMessage,
  resolveCaptainPendingUserInputAdvance,
} from "./captainComposer.logic";
import { CaptainComposerBlockedPanel } from "./CaptainComposerBlockedPanel";

const NO_TERMINAL_CONTEXTS: ReadonlyArray<never> = [];
const NO_SKILLS: ReadonlyArray<never> = [];

/**
 * The messenger composer (MESSENGER-PIVOT §3).
 *
 * Built on `ComposerPromptEditor` and the pure submission helpers
 * (`submitComposerDraft`, `getComposerSubmissionValidationMessage`,
 * `resolveComposerTurnDispatch`), *not* on the 3,528-line `ChatComposer`. The
 * messenger has no worktree selector, model picker, publish bar, or slash-menu
 * surface, and inheriting a component whose job is to host all of them would
 * put a mode axis inside it — the exact failure the maintenance lens rejected.
 *
 * What it does inherit unchanged are the controls that appear when the thread
 * is *blocked*. An approval or a pending question is a decision the captain
 * still has to make, so both panels mount here **with their actions wired to
 * the real commands**: `ade:approve` and the user-input response go through
 * the same `threadEnvironment` atoms the workspace uses. A blocked messenger
 * that could only *display* the decision would be a dead end — the captain
 * would have to leave the conversation to unblock the conversation.
 *
 * Turn commands go through the `threadEnvironment` atoms
 * (`client-runtime/state/threadCommands.ts`, re-exported by `state/threads.ts`),
 * so an ADE bot chat sends exactly the way any other thread sends.
 */
export function CaptainComposer({
  environmentId,
  threadRef,
  thread,
  botName,
  disabled = false,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThread | null;
  readonly botName: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [cursor, setCursor] = useState(0);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // The draft lives in the shared composer store, keyed by `ScopedThreadRef`.
  // Local state would lose the captain's half-written line every time they
  // switched contacts or flipped between message and workspace view — the two
  // things this surface invites them to do constantly.
  const draft = useComposerThreadDraft(threadRef);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prompt = draft.prompt;
  const setPrompt = useCallback(
    (next: string) => {
      setComposerDraftPrompt(threadRef, next);
    },
    [setComposerDraftPrompt, threadRef],
  );
  // Read at press time rather than closed over, so a press always sees the
  // line that is actually in the box.
  const readPrompt = useCallback(
    () => useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "",
    [threadRef],
  );

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const steerTurn = useAtomCommand(threadEnvironment.steerTurn, { reportFailure: false });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });

  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);
  const blockedState = useMemo(
    () => resolveCaptainComposerBlockedState({ pendingApprovals, pendingUserInputs }),
    [pendingApprovals, pendingUserInputs],
  );
  const submissionTarget = resolveCaptainComposerSubmissionTarget(blockedState);
  const editorDisabled = disabled || isCaptainComposerEditorDisabled(blockedState);
  const activePendingUserInput =
    blockedState.kind === "pending-user-input" ? blockedState.pendingUserInput : null;

  // Pending-question state, mirroring `ChatView`'s: answers and the question
  // cursor are keyed by request id so a second prompt does not inherit the
  // first one's half-filled draft.
  const [answersByRequestId, setAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [questionIndexByRequestId, setQuestionIndexByRequestId] = useState<Record<string, number>>(
    {},
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<Array<ApprovalRequestId>>([]);

  const activeAnswers = activePendingUserInput
    ? (answersByRequestId[activePendingUserInput.requestId] ?? EMPTY_ANSWERS)
    : EMPTY_ANSWERS;
  const activeQuestionIndex = activePendingUserInput
    ? (questionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activeQuestionId =
    activePendingUserInput?.questions[
      Math.min(activeQuestionIndex, Math.max(activePendingUserInput.questions.length - 1, 0))
    ]?.id ?? null;

  // A question arriving (or advancing) hands the editor a fresh line: the
  // previous answer is already recorded in `answersByRequestId`, and leaving it
  // in the box invites sending it twice.
  const answerCursorKey = `${activePendingUserInput?.requestId ?? ""}:${activeQuestionId ?? ""}`;
  const previousAnswerCursorKeyRef = useRef(answerCursorKey);
  useEffect(() => {
    if (previousAnswerCursorKeyRef.current === answerCursorKey) return;
    previousAnswerCursorKeyRef.current = answerCursorKey;
    if (activePendingUserInput === null) return;
    setPrompt("");
    setCursor(0);
  }, [activePendingUserInput, answerCursorKey, setPrompt]);

  const onChange = useCallback(
    (nextValue: string, nextCursor: number) => {
      setPrompt(nextValue);
      setCursor(nextCursor);
      setValidationMessage(null);
      // While a question is open the box *is* the custom-answer field, exactly
      // as it is in the workspace composer.
      if (activePendingUserInput === null || activeQuestionId === null) return;
      const requestId = activePendingUserInput.requestId;
      setAnswersByRequestId((existing) => ({
        ...existing,
        [requestId]: {
          ...existing[requestId],
          [activeQuestionId]: setPendingUserInputCustomAnswer(
            existing[requestId]?.[activeQuestionId],
            nextValue,
          ),
        },
      }));
    },
    [activePendingUserInput, activeQuestionId, setPrompt],
  );

  const onToggleOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (activePendingUserInput === null) return;
      const requestId = activePendingUserInput.requestId;
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (question === undefined) return;
      setAnswersByRequestId((existing) => ({
        ...existing,
        [requestId]: {
          ...existing[requestId],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[requestId]?.[questionId],
            optionLabel,
          ),
        },
      }));
      // Selecting an option retires whatever was typed, so the box must not
      // keep offering it as the answer.
      setPrompt("");
      setCursor(0);
    },
    [activePendingUserInput, setPrompt],
  );

  const submitPendingUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, string | string[]>) => {
      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToUserInput({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, answers },
      });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      if (result._tag === "Failure") {
        setValidationMessage(`The answer could not be sent to ${botName}.`);
        return;
      }
      setPrompt("");
      setCursor(0);
    },
    [botName, environmentId, respondToUserInput, setPrompt, threadRef.threadId],
  );

  const onAdvance = useCallback(() => {
    if (activePendingUserInput === null) return;
    const advance = resolveCaptainPendingUserInputAdvance({
      pendingUserInput: activePendingUserInput,
      answers: activeAnswers,
      questionIndex: activeQuestionIndex,
    });
    if (advance._tag === "incomplete") return;
    if (advance._tag === "next-question") {
      setQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: advance.questionIndex,
      }));
      return;
    }
    void submitPendingUserInput(advance.requestId, advance.answers);
  }, [activeAnswers, activePendingUserInput, activeQuestionIndex, submitPendingUserInput]);

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToApproval({
        environmentId,
        input: { threadId: threadRef.threadId, requestId, decision },
      });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      if (result._tag === "Failure") {
        setValidationMessage("The approval decision could not be sent.");
      }
      return result;
    },
    [environmentId, respondToApproval, threadRef.threadId],
  );

  const dispatchTurn = useCallback(
    async (turnDispatch: ComposerTurnDispatch, text: string) => {
      if (thread === null || turnDispatch._tag === "blocked") return;
      setSending(true);
      // Cleared *before* the await, the way a messenger clears: the captain's
      // line is already in the timeline optimistically, and a draft that lingers
      // for the length of a round trip invites a duplicate send. A failure puts
      // it back verbatim rather than losing it.
      setPrompt("");
      setCursor(0);

      const message = {
        messageId: newMessageId(),
        role: "user" as const,
        text,
        attachments: [],
      };
      const createdAt = new Date().toISOString();
      const result =
        turnDispatch._tag === "steer"
          ? await steerTurn({
              environmentId,
              input: {
                threadId: threadRef.threadId,
                expectedTurnId: turnDispatch.expectedTurnId,
                message,
                createdAt,
              },
            })
          : await startTurn({
              environmentId,
              input: {
                threadId: threadRef.threadId,
                message,
                createdAt,
                // The messenger has no runtime/interaction pickers by design
                // (§2). A bot conversation continues in whatever modes the
                // thread already carries rather than silently re-selecting them.
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              },
            });
      setSending(false);
      if (result._tag === "Failure") {
        setPrompt(text);
        setCursor(text.length);
        setValidationMessage(`The message could not be sent to ${botName}.`);
        return;
      }
      editorRef.current?.focusAtEnd();
    },
    [botName, environmentId, setPrompt, startTurn, steerTurn, thread, threadRef.threadId],
  );

  /**
   * The single writer for `validationMessage`.
   *
   * `submitComposerDraft` reports its own (length) verdict, and the dispatch
   * path reports whether the turn could be started at all. Both are collected
   * here and written *once*, so a "this provider cannot steer mid-turn" message
   * can no longer be erased by the press that produced it — the defect that made
   * Enter mid-turn look like it did nothing.
   */
  const submit = useCallback(
    (event?: { preventDefault: () => void }) => {
      const dispatchOutcome: { message: string | null } = { message: null };
      const outcome = submitComposerDraft({
        prompt: readPrompt(),
        submissionTarget,
        event,
        onSend: () => {
          if (submissionTarget === "pending-user-input") {
            onAdvance();
            return;
          }
          const text = readPrompt().trim();
          if (text.length === 0 || thread === null) return false;
          const turnDispatch = resolveComposerTurnDispatch({
            isServerThread: true,
            session: thread.session,
          });
          const blockedMessage = resolveCaptainDispatchValidationMessage({ turnDispatch, botName });
          if (blockedMessage !== null) {
            dispatchOutcome.message = blockedMessage;
            return false;
          }
          void dispatchTurn(turnDispatch, text);
          return;
        },
      });
      setValidationMessage(dispatchOutcome.message ?? outcome.validationMessage);
    },
    [botName, dispatchTurn, onAdvance, readPrompt, submissionTarget, thread],
  );

  const onCommandKeyDown = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent) => {
      if (key !== "Enter" || event.shiftKey) return false;
      submit({ preventDefault: () => event.preventDefault() });
      return true;
    },
    [submit],
  );

  // Surfaced before the send is attempted, so an over-length draft is flagged
  // while it is being written rather than on the press.
  const liveValidationMessage =
    validationMessage ?? getComposerSubmissionValidationMessage({ prompt, submissionTarget });
  const canAnswer =
    activePendingUserInput !== null &&
    resolveCaptainPendingUserInputAdvance({
      pendingUserInput: activePendingUserInput,
      answers: activeAnswers,
      questionIndex: activeQuestionIndex,
    })._tag !== "incomplete";
  const canSend =
    !sending &&
    !disabled &&
    (activePendingUserInput !== null
      ? canAnswer && !respondingRequestIds.includes(activePendingUserInput.requestId)
      : blockedState.kind === "free" && prompt.trim().length > 0);

  return (
    <div className={cn("shrink-0 border-t border-border bg-background px-3 py-2.5", className)}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        {/*
         * Blocked states mount the workspace panels unchanged — *including*
         * their actions: one decision path, rendered wherever the captain
         * happens to be standing.
         */}
        <CaptainComposerBlockedPanel
          answers={activeAnswers}
          blocked={blockedState}
          onAdvance={onAdvance}
          onRespondToApproval={onRespondToApproval}
          onToggleOption={onToggleOption}
          pendingUserInputs={pendingUserInputs}
          questionIndex={activeQuestionIndex}
          respondingRequestIds={respondingRequestIds}
        />
        {/*
         * `ComposerPromptEditor`'s `className` lands on the Lexical
         * `ContentEditable`, not on its wrapper — flex sizing has to go on the
         * dock itself, and the send button floats over a reserved gutter rather
         * than sitting in the same flex row as a min-height text area.
         */}
        <div className="relative rounded-2xl border border-border bg-card px-3 py-2">
          <ComposerPromptEditor
            className="pr-10"
            cursor={cursor}
            disabled={editorDisabled}
            editorRef={editorRef}
            onChange={onChange}
            onCommandKeyDown={onCommandKeyDown}
            onPaste={NOOP}
            onRemoveTerminalContext={NOOP}
            placeholder={
              blockedState.kind === "approval"
                ? `Answer ${botName} first`
                : blockedState.kind === "pending-user-input"
                  ? "Type an answer, or pick an option"
                  : `Message ${botName}`
            }
            skills={NO_SKILLS}
            terminalContexts={NO_TERMINAL_CONTEXTS}
            value={prompt}
          />
          <Button
            aria-label={
              submissionTarget === "pending-user-input" ? "Send answer" : `Send to ${botName}`
            }
            className="absolute right-2 bottom-2 size-8 shrink-0 rounded-full"
            disabled={!canSend}
            onClick={() => submit()}
            size="icon-sm"
          >
            <ArrowUpIcon aria-hidden className="size-4" />
          </Button>
        </div>
        {liveValidationMessage === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {liveValidationMessage}
          </p>
        )}
      </div>
    </div>
  );
}

const NOOP = () => {};
const EMPTY_ACTIVITIES: EnvironmentThread["activities"] = [];
const EMPTY_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
