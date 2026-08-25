/**
 * Pure view logic for the Needs You surface (spec §7 slice 5, UI slice 5).
 *
 * The inbox and the inline rendering are two components over *one* list. That
 * only stays true if selection, filtering, and the approve/deny affordance are
 * decided here rather than twice in JSX — so both renderings offer the same
 * actions on the same item, and a decision made in either one is described the
 * same way.
 */
import {
  AuthAdeApproveScope,
  type AdeNeedsYouEntry,
  type NeedsYouAction,
  type NeedsYouDecision,
  type NeedsYouItemId,
} from "@shuv2code/contracts";

import { isBenignNeedsYouConflict, type AdeCaptainErrorReason } from "../../state/ade.logic";

export interface NeedsYouSubject {
  readonly botId?: string | null;
  readonly projectId?: string | null;
  readonly assignmentId?: string | null;
}

/**
 * The inline rendering shows only what is about the thing on screen, and only
 * what is still open — an inline card for a resolved item is clutter beside a
 * conversation. The inbox is where history lives.
 */
export function entriesForSubject(
  entries: ReadonlyArray<AdeNeedsYouEntry>,
  subject: NeedsYouSubject,
): ReadonlyArray<AdeNeedsYouEntry> {
  const wanted = [
    subject.botId === undefined || subject.botId === null
      ? null
      : (entry: AdeNeedsYouEntry) => entry.botId === subject.botId,
    subject.projectId === undefined || subject.projectId === null
      ? null
      : (entry: AdeNeedsYouEntry) => entry.projectId === subject.projectId,
    subject.assignmentId === undefined || subject.assignmentId === null
      ? null
      : (entry: AdeNeedsYouEntry) => entry.assignmentId === subject.assignmentId,
  ].filter((predicate) => predicate !== null);
  if (wanted.length === 0) return [];
  return entries.filter(
    (entry) => entry.item.status === "open" && wanted.some((matches) => matches(entry)),
  );
}

/**
 * Which item the detail pane shows. An explicit selection wins while it is
 * still in the list; otherwise the inbox opens on the thing most likely to be
 * why the captain came — the first item they can act on.
 */
export function selectNeedsYouEntry(
  entries: ReadonlyArray<AdeNeedsYouEntry>,
  requestedId: NeedsYouItemId | null,
): AdeNeedsYouEntry | null {
  if (requestedId !== null) {
    const requested = entries.find((entry) => entry.item.id === requestedId);
    if (requested !== undefined) return requested;
  }
  return entries.find((entry) => entry.actionable) ?? entries[0] ?? null;
}

/**
 * Whether this client holds `ade:approve` (spec §5). Positive knowledge only:
 * a session that has not resolved yet, or a server that does not report
 * scopes, leaves the controls up and lets the server refuse — the typed
 * authorization error is the authority, and hiding approval on a *guess* is
 * how a captain ends up unable to approve anything with no explanation.
 */
export function canApproveWithSession(
  session: { readonly authenticated?: boolean; readonly scopes?: ReadonlyArray<string> } | null,
): boolean {
  if (session === null || session.scopes === undefined) return true;
  if (session.authenticated === false) return false;
  return session.scopes.includes(AuthAdeApproveScope);
}

export interface NeedsYouDecisionView {
  readonly canDecide: boolean;
  /**
   * Which control to render. `approve-deny` gets Approve and Deny;
   * `acknowledge` gets a single Acknowledge, because nothing is waiting on a
   * verdict — the item just has no automatic way to clear.
   */
  readonly action: NeedsYouAction | null;
  /** Why the buttons are absent, when they are. Null while they are shown. */
  readonly unavailableReason: string | null;
}

/**
 * The captain's controls, offered when the server says the item still takes an
 * action and the connection carries `ade:approve` (spec §5). An unscoped client
 * is told so rather than shown buttons that will fail — the scope is a property
 * of how this client paired, not a transient error.
 */
export function getNeedsYouDecisionView(input: {
  readonly entry: AdeNeedsYouEntry | null;
  readonly canApprove: boolean;
  readonly busy: boolean;
}): NeedsYouDecisionView {
  if (input.entry === null) {
    return { canDecide: false, action: null, unavailableReason: null };
  }
  const action = input.entry.action;
  if (action === null) {
    return {
      canDecide: false,
      action: null,
      unavailableReason:
        input.entry.item.status === "open"
          ? "This clears on its own once the condition does."
          : "Already resolved.",
    };
  }
  if (!input.canApprove) {
    return {
      canDecide: false,
      action,
      unavailableReason:
        "This client cannot approve. Open the app from the server's startup link, or pair with `ade:approve`.",
    };
  }
  return { canDecide: !input.busy, action, unavailableReason: null };
}

/**
 * What the captain reads after deciding. A conflict is an outcome, not an
 * error: it means the other rendering — or the service itself — already
 * retired the item, which is exactly what "one durable item" promises.
 */
export function describeDecisionOutcome(input: {
  readonly reason: AdeCaptainErrorReason | null;
  readonly decision: NeedsYouDecision;
  readonly failed: boolean;
  readonly fallback: string;
}): { readonly tone: "ok" | "conflict" | "error"; readonly message: string } {
  if (!input.failed) {
    return {
      tone: "ok",
      message:
        input.decision === "approve"
          ? "Approved."
          : input.decision === "deny"
            ? "Denied — bounced for repair."
            : "Cleared.",
    };
  }
  if (isBenignNeedsYouConflict(input.reason)) {
    return { tone: "conflict", message: "Already handled elsewhere." };
  }
  return { tone: "error", message: input.fallback };
}
