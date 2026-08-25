import type { ApprovalRequestId, EnvironmentId, ScopedThreadRef } from "@shuv2code/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { newMessageId } from "../../lib/utils";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import type { EnvironmentThread } from "@shuv2code/client-runtime/state/models";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import {
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "../chat/composerSubmission";
import { resolveComposerTurnDispatch } from "../chat/composerTurnDispatch";
import { Button } from "../ui/button";

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
 * What it does inherit unchanged are the two panels that appear when the thread
 * is *blocked*: an approval or a pending question is a decision the captain
 * still has to make, and re-cutting those controls would mean a second
 * decision path for the same durable item.
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
  const promptRef = useRef("");
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const steerTurn = useAtomCommand(threadEnvironment.steerTurn, { reportFailure: false });

  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const blocked = activePendingApproval !== null || pendingUserInputs.length > 0;

  const onChange = useCallback((nextValue: string, nextCursor: number) => {
    promptRef.current = nextValue;
    setPrompt(nextValue);
    setCursor(nextCursor);
    setValidationMessage(null);
  }, []);

  const dispatchTurn = useCallback(async () => {
    const text = promptRef.current.trim();
    if (text.length === 0 || thread === null) return;

    const turnDispatch = resolveComposerTurnDispatch({
      isServerThread: true,
      session: thread.session,
    });
    if (turnDispatch._tag === "blocked") {
      setValidationMessage(
        turnDispatch.reason === "turn-steering-unsupported"
          ? `${botName} is mid-turn and this provider cannot steer it. Try again when it finishes.`
          : "This conversation is still synchronizing. Try again in a moment.",
      );
      return;
    }

    setSending(true);
    // Cleared *before* the await, the way a messenger clears: the captain's
    // line is already in the timeline optimistically, and a draft that lingers
    // for the length of a round trip invites a duplicate send. A failure puts
    // it back verbatim rather than losing it.
    promptRef.current = "";
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
      promptRef.current = text;
      setPrompt(text);
      setCursor(text.length);
      setValidationMessage(`The message could not be sent to ${botName}.`);
      return;
    }
    editorRef.current?.focusAtEnd();
  }, [botName, environmentId, startTurn, steerTurn, thread, threadRef.threadId]);

  const submit = useCallback(
    (event?: { preventDefault: () => void }) => {
      const outcome = submitComposerDraft({
        prompt: promptRef.current,
        submissionTarget: "provider-turn",
        event,
        onSend: () => {
          void dispatchTurn();
        },
      });
      setValidationMessage(outcome.validationMessage);
    },
    [dispatchTurn],
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
    validationMessage ??
    getComposerSubmissionValidationMessage({ prompt, submissionTarget: "provider-turn" });
  const canSend = prompt.trim().length > 0 && !sending && !disabled && !blocked;

  return (
    <div className={cn("shrink-0 border-t border-border bg-background px-3 py-2.5", className)}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        {/*
         * Blocked states mount the workspace panels unchanged: one decision
         * path, rendered wherever the captain happens to be standing.
         */}
        {activePendingApproval !== null ? (
          <div className="rounded-xl border border-border/65 bg-muted/20">
            <ComposerPendingApprovalPanel
              approval={activePendingApproval}
              pendingCount={pendingApprovals.length}
            />
          </div>
        ) : pendingUserInputs.length > 0 ? (
          <div className="rounded-xl border border-border/65 bg-muted/20">
            <ComposerPendingUserInputPanel
              answers={EMPTY_ANSWERS}
              onAdvance={NOOP}
              onToggleOption={NOOP}
              pendingUserInputs={pendingUserInputs}
              questionIndex={0}
              respondingRequestIds={EMPTY_RESPONDING}
            />
          </div>
        ) : null}
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
            disabled={disabled || blocked}
            editorRef={editorRef}
            onChange={onChange}
            onCommandKeyDown={onCommandKeyDown}
            onPaste={NOOP}
            onRemoveTerminalContext={NOOP}
            placeholder={blocked ? `Answer ${botName} first` : `Message ${botName}`}
            skills={NO_SKILLS}
            terminalContexts={NO_TERMINAL_CONTEXTS}
            value={prompt}
          />
          <Button
            aria-label={`Send to ${botName}`}
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
const EMPTY_ANSWERS = {};
const EMPTY_RESPONDING: Array<ApprovalRequestId> = [];
