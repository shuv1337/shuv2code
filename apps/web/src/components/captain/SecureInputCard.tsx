import type { AdeNeedsYouEntry } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary/sessionState";
import { cn } from "../../lib/utils";
import { adeEnvironment, useAdeEnvironmentId } from "../../state/ade";
import { adeCaptainErrorMessage, adeCaptainErrorReason } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  canApproveWithSession,
  describeDecisionOutcome,
  getNeedsYouDecisionView,
} from "../fleet/NeedsYouInbox.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { canSubmitSecureInput, resolveSecureInputFieldLabel } from "./richCards.logic";

/**
 * The secure-input card (MESSENGER-PIVOT §3, §6 M5).
 *
 * A `form` Needs You item is the fleet asking the captain to *type a value*,
 * and the product already reads that kind as credential-bearing:
 * `suppressesPreview` (`apps/server/src/ade/adeRosterLiveness.ts`) withholds a
 * bot's roster preview entirely while a `form` item is open, and does so for
 * that kind alone. This card is the rendering that assumption was waiting for.
 *
 * ## One decision path
 * It submits `ade.submitNeedsYouDecision` — the *same* RPC `NeedsYouCard`
 * submits, for the same item id — so the item retires exactly once no matter
 * which rendering the captain used, fenced by the server's conditional
 * `UPDATE … WHERE status = 'open'`. A second submit comes back
 * `needs_you_already_resolved`, which `describeDecisionOutcome` reports as the
 * benign "Already handled elsewhere." rather than as an error. Sharing the
 * decision *logic* — `getNeedsYouDecisionView`, `canApproveWithSession`,
 * `describeDecisionOutcome` — with `NeedsYouCard` is what keeps that from being
 * two code paths that merely agree today.
 *
 * ## The value never becomes text
 * Three things hold, and each is a place the value could have leaked:
 * - it is never put into React state that renders — the field is
 *   **uncontrolled**, read once from the DOM at submit and cleared immediately;
 * - it is never written to the transcript: this card is not a composer, and it
 *   sends no message;
 * - it never reaches a durable column: the server withholds `note` by item kind
 *   before forwarding, so a `form` answer cannot reach `verdict_detail` or a
 *   bot-facing repair instruction.
 * Nothing here logs the value, and the outcome line reports only *that* it was
 * saved.
 */
/**
 * The masked field and its Save control, with no atoms and no secret in sight.
 *
 * Split out so the never-echoed contract can be *rendered* in a test rather
 * than argued about: this component has no prop that could carry the value, so
 * no rendering of it can contain one. The field is uncontrolled — the card
 * reads `inputRef.current.value` once at submit — which is the mechanism that
 * keeps the secret out of React state, out of a devtools inspector, and out of
 * anything that serializes props.
 */
export function SecureInputField({
  fieldId,
  label,
  busy,
  canSubmit,
  inputRef,
  onChangeHasValue,
  onSubmit,
}: {
  readonly fieldId: string;
  readonly label: string;
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  /** Length only — never the value. */
  readonly onChangeHasValue: (hasValue: boolean) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="text-xs font-medium text-muted-foreground" htmlFor={fieldId}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          // `new-password` rather than `off`: password managers ignore `off`,
          // and an autofilled credential from a previous item is its own leak.
          autoComplete="new-password"
          className="min-w-0 flex-1 font-mono"
          disabled={busy}
          id={fieldId}
          onChange={(event) => onChangeHasValue(event.currentTarget.value.length > 0)}
          placeholder="Paste the value"
          ref={inputRef}
          spellCheck={false}
          type="password"
        />
        <Button disabled={!canSubmit} size="sm" type="submit">
          Save securely
        </Button>
      </div>
    </form>
  );
}

export function SecureInputCard({
  entry,
  className,
}: {
  readonly entry: AdeNeedsYouEntry;
  readonly className?: string;
}) {
  const environmentId = useAdeEnvironmentId();
  const session = usePrimarySessionState();
  const submit = useAtomCommand(adeEnvironment.submitNeedsYouDecision, { reportFailure: false });
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Length only — enough to enable Save, never the value itself. Holding the
  // secret in state would put it in a render tree, a devtools inspector, and
  // any future error boundary that serializes props.
  const [hasValue, setHasValue] = useState(false);
  const [outcome, setOutcome] = useState<ReturnType<typeof describeDecisionOutcome> | null>(null);

  const decisionView = getNeedsYouDecisionView({
    entry,
    canApprove: canApproveWithSession(session.data),
    busy,
  });
  const fieldLabel = resolveSecureInputFieldLabel(entry.title);
  const canSubmit =
    decisionView.canDecide &&
    canSubmitSecureInput({ value: hasValue ? "x" : "", busy, status: entry.item.status });

  const save = async () => {
    if (environmentId === null) return;
    const field = inputRef.current;
    if (field === null) return;
    const secret = field.value;
    if (secret.length === 0) return;
    // Cleared before the await, not after: an in-flight request must not leave
    // the value sitting in the DOM where a screenshot or a bug report catches
    // it, and the request already holds the only copy it needs.
    field.value = "";
    setHasValue(false);
    setBusy(true);
    setOutcome(null);
    const result = await submit({
      environmentId,
      input: { needsYouItemId: entry.item.id, decision: "acknowledge", note: secret },
    });
    setBusy(false);
    const failed = result._tag === "Failure";
    const squashed = failed ? squashAtomCommandFailure(result) : null;
    setOutcome(
      describeDecisionOutcome({
        decision: "acknowledge",
        failed,
        reason: adeCaptainErrorReason(squashed),
        fallback: adeCaptainErrorMessage(squashed, "That value could not be saved."),
      }),
    );
  };

  return (
    <article
      className={cn(
        "flex max-w-[min(90%,34rem)] flex-col gap-2 self-start rounded-2xl rounded-bl-md border border-sky-500/40 bg-sky-500/5 p-3",
        entry.item.status === "open" ? null : "opacity-70",
        className,
      )}
      data-needs-you-id={entry.item.id}
      data-needs-you-variant="secure-input"
    >
      <div className="flex items-start gap-2">
        <Badge size="sm" variant={entry.actionable ? "destructive" : "secondary"}>
          Secure
        </Badge>
        <h3 className="min-w-0 flex-1 text-sm font-medium">{entry.title}</h3>
        {entry.item.status === "open" ? null : (
          <span className="text-xs text-muted-foreground">Resolved</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{entry.detail}</p>

      {decisionView.canDecide || busy ? (
        <SecureInputField
          busy={busy}
          canSubmit={canSubmit}
          fieldId={fieldId}
          inputRef={inputRef}
          label={fieldLabel}
          onChangeHasValue={setHasValue}
          onSubmit={() => void save()}
        />
      ) : decisionView.unavailableReason === null ? null : (
        <p className="text-xs text-muted-foreground">{decisionView.unavailableReason}</p>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0" />
        {/* #217: one clause, not three descriptions of this app's storage. */}
        Never stored in this conversation.
      </p>

      {outcome === null ? null : (
        <p
          className={cn(
            "text-xs",
            outcome.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={outcome.tone === "error" ? "alert" : "status"}
        >
          {outcome.tone === "ok" ? "Saved securely." : outcome.message}
        </p>
      )}
    </article>
  );
}
