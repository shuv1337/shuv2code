import type { ApprovalRequestId, ProviderApprovalDecision } from "@shuv2code/contracts";

import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import type { CaptainComposerBlockedState } from "./captainComposer.logic";

/**
 * The decision the captain is standing in front of, drawn above the composer.
 *
 * Purely presentational, and separate from `CaptainComposer` so the decision
 * surface can be rendered — and its actions exercised — without the thread
 * atoms behind it.
 *
 * The load-bearing detail is that the approval panel ships **with**
 * `ComposerPendingApprovalActions`. Mounting the panel alone renders a
 * description of a decision with no way to make it: the captain could read
 * "Command approval requested" in the messenger and would then have to leave
 * for the workspace to approve or deny it. A blocked conversation that cannot
 * be unblocked from where it is blocked is a dead end.
 */
export function CaptainComposerBlockedPanel({
  blocked,
  answers,
  questionIndex,
  respondingRequestIds,
  pendingUserInputs,
  onRespondToApproval,
  onToggleOption,
  onAdvance,
}: {
  readonly blocked: CaptainComposerBlockedState;
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly respondingRequestIds: Array<ApprovalRequestId>;
  readonly pendingUserInputs: Array<PendingUserInput>;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onToggleOption: (questionId: string, optionLabel: string) => void;
  readonly onAdvance: () => void;
}) {
  if (blocked.kind === "approval") {
    return (
      <div className="rounded-xl border border-border/65 bg-muted/20">
        <ComposerPendingApprovalPanel
          approval={blocked.approval}
          pendingCount={blocked.pendingCount}
        />
        <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
          <ComposerPendingApprovalActions
            isResponding={respondingRequestIds.includes(blocked.approval.requestId)}
            onRespondToApproval={onRespondToApproval}
            requestId={blocked.approval.requestId}
            requestKind={blocked.approval.requestKind}
          />
        </div>
      </div>
    );
  }
  if (blocked.kind === "pending-user-input") {
    return (
      <div className="rounded-xl border border-border/65 bg-muted/20">
        <ComposerPendingUserInputPanel
          answers={answers}
          onAdvance={onAdvance}
          onToggleOption={onToggleOption}
          pendingUserInputs={pendingUserInputs}
          questionIndex={questionIndex}
          respondingRequestIds={respondingRequestIds}
        />
      </div>
    );
  }
  return null;
}
