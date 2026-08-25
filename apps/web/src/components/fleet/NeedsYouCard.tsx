import type { AdeNeedsYouEntry, NeedsYouDecision } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { useState } from "react";

import { usePrimarySessionState } from "../../environments/primary/sessionState";
import { cn } from "../../lib/utils";
import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  canApproveWithSession,
  describeDecisionOutcome,
  getNeedsYouDecisionView,
} from "./NeedsYouInbox.logic";

const KIND_LABELS: Readonly<Record<AdeNeedsYouEntry["item"]["kind"], string>> = {
  approval: "Approval",
  "kernel-down": "Kernel",
  stall: "Stalled",
  "provision-failure": "Desktop",
  form: "Question",
};

/**
 * The one rendering of a Needs You item (spec §7 slice 5).
 *
 * "One durable item, two renderings" is a claim about *resolution*, not about
 * markup: the inbox and the inline surface both mount this card, so both send
 * the same `ade.submitNeedsYouDecision` for the same id, and the item retires
 * exactly once no matter which one the captain used. Making the surfaces share
 * the component is what keeps that from being two code paths that agree today.
 */
export function NeedsYouCard({
  entry,
  variant = "inbox",
}: {
  readonly entry: AdeNeedsYouEntry;
  readonly variant?: "inbox" | "inline";
}) {
  const environmentId = useAdeEnvironmentId();
  const session = usePrimarySessionState();
  const submit = useAtomCommand(adeEnvironment.submitNeedsYouDecision, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReturnType<typeof describeDecisionOutcome> | null>(null);

  const decisionView = getNeedsYouDecisionView({
    entry,
    canApprove: canApproveWithSession(session.data),
    busy,
  });

  const decide = async (decision: NeedsYouDecision) => {
    if (environmentId === null) return;
    setBusy(true);
    setOutcome(null);
    const result = await submit({
      environmentId,
      input: { needsYouItemId: entry.item.id, decision },
    });
    setBusy(false);
    const failed = result._tag === "Failure";
    const squashed = failed ? squashAtomCommandFailure(result) : null;
    setOutcome(
      describeDecisionOutcome({
        decision,
        failed,
        reason: adeCaptainErrorReason(squashed),
        fallback: adeCaptainErrorMessage(squashed, "That decision could not be applied."),
      }),
    );
  };

  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        variant === "inline" ? "bg-muted/40" : "bg-card",
        entry.item.status === "open" ? null : "opacity-70",
      )}
      data-needs-you-id={entry.item.id}
      data-needs-you-variant={variant}
    >
      <div className="flex items-start gap-2">
        <Badge size="sm" variant={entry.actionable ? "destructive" : "secondary"}>
          {KIND_LABELS[entry.item.kind]}
        </Badge>
        <h3 className="min-w-0 flex-1 text-sm font-medium">{entry.title}</h3>
        {entry.item.status === "open" ? null : (
          <span className="text-xs text-muted-foreground">Resolved</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{entry.detail}</p>
      {decisionView.canDecide || busy ? (
        <div className="flex items-center gap-2">
          {decisionView.action === "acknowledge" ? (
            // Nothing is waiting on a verdict here; the captain is confirming
            // they have seen a thing no service will ever clear on its own.
            <Button
              disabled={busy}
              onClick={() => void decide("acknowledge")}
              size="sm"
              variant="outline"
            >
              Acknowledge
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => void decide("approve")} size="sm">
                Approve
              </Button>
              <Button
                disabled={busy}
                onClick={() => void decide("deny")}
                size="sm"
                variant="outline"
              >
                Deny
              </Button>
            </>
          )}
        </div>
      ) : decisionView.unavailableReason === null ? null : (
        <p className="text-xs text-muted-foreground">{decisionView.unavailableReason}</p>
      )}
      {outcome === null ? null : (
        <p
          className={cn(
            "text-xs",
            outcome.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={outcome.tone === "error" ? "alert" : "status"}
        >
          {outcome.message}
        </p>
      )}
    </article>
  );
}
