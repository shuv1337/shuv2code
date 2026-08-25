import type {
  AdeBotDetail,
  AdeCaptainError,
  BotExecutionBinding,
  BotStructuralRole,
  FleetHealthSnapshot,
} from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "@shuv2code/client-runtime/connection";

/**
 * The fleet-health subscription atom retains its last success while the
 * WebSocket re-establishes, but stale health is worse than no health — a
 * "healthy" pill during an outage of the connection itself is a lie.
 * Anything but a live `connected` phase reads as no snapshot, so the pills
 * fall back to `unknown` until the resubscribed feed pushes fresh state.
 */
export function fleetHealthForConnectionPhase(
  phase: SupervisorConnectionState["phase"],
  snapshot: FleetHealthSnapshot | null,
): FleetHealthSnapshot | null {
  return phase === "connected" ? snapshot : null;
}

export type AdeCaptainErrorReason = AdeCaptainError["reason"];

/**
 * Narrows a squashed command failure to the closed captain-error union. The
 * RPC layer already collapses the server's rich errors into `reason`, so the
 * surfaces branch on this rather than on message text; anything else — a
 * transport fault, an authorization refusal — reads as `null` and falls back
 * to a generic message.
 */
export function adeCaptainErrorReason(error: unknown): AdeCaptainErrorReason | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as { readonly _tag?: unknown; readonly reason?: unknown };
  if (candidate._tag !== "AdeCaptainError" || typeof candidate.reason !== "string") {
    return null;
  }
  return candidate.reason as AdeCaptainErrorReason;
}

/**
 * What the captain surfaces show inline when a mutation fails. Every reason
 * gets its own sentence because the recovery differs: a conflict needs a
 * reload, an unavailable session needs nothing but patience, and the app is
 * never gated on either (spec §4.1).
 */
const CAPTAIN_ERROR_TEXT: Record<AdeCaptainErrorReason, string> = {
  bot_not_found: "That bot no longer exists.",
  template_not_instantiable: "That template cannot be added right now.",
  memory_conflict: "Memory changed elsewhere — reload before saving.",
  memory_too_large: "That memory document is too large to save.",
  persona_invalid: "That persona could not be saved.",
  session_unavailable: "No kernel session is available right now.",
  project_invalid: "That project could not be created.",
  project_not_found: "That project no longer exists.",
  persistence_failed: "The change could not be saved.",
  needs_you_not_found: "That item is no longer in your inbox.",
  // Not a failure the captain caused: the other rendering of the same item, or
  // the service that raised it, got there first.
  needs_you_already_resolved: "Already handled — this item is resolved.",
  needs_you_not_actionable: "This item resolves on its own; there is nothing to approve.",
  needs_you_decision_rejected: "That decision could not be applied — the item is still waiting.",
  firstmate_permanent: "The Firstmate is permanent and cannot be deleted.",
  // The server appends the upstream detail, which is the part that says what
  // to do next — cap reached, computer use off, Screenbox unreachable.
  screenbox_unavailable: "The desktop is unavailable.",
};

/**
 * Reasons that mean "someone else already did it", not "you did something
 * wrong". Both renderings show these as an outcome, never as an error.
 */
export function isBenignNeedsYouConflict(reason: AdeCaptainErrorReason | null): boolean {
  return reason === "needs_you_already_resolved" || reason === "needs_you_not_found";
}

export function adeCaptainErrorMessage(error: unknown, fallback: string): string {
  const reason = adeCaptainErrorReason(error);
  if (reason !== null) {
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === "string" && message.trim().length > 0
      ? `${CAPTAIN_ERROR_TEXT[reason]} ${message.trim()}`
      : CAPTAIN_ERROR_TEXT[reason];
  }
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

const STRUCTURAL_ROLE_LABELS: Record<BotStructuralRole, string> = {
  firstmate: "Firstmate",
  "second-mate": "Second Mate",
  crew: "Crew",
  "workspace-specialist": "Workspace specialist",
};

export function structuralRoleLabel(role: BotStructuralRole): string {
  return STRUCTURAL_ROLE_LABELS[role];
}

/**
 * The bot's live chat binding, if any. Spec §4.1 forbids starting a kernel
 * session on mount, so the chat page reads this to decide between the canned
 * welcome and the real conversation.
 */
export function activePrimaryBinding(
  bindings: ReadonlyArray<BotExecutionBinding>,
): BotExecutionBinding | null {
  return (
    bindings.find((binding) => binding.purpose === "primary-text" && binding.status === "active") ??
    null
  );
}

/** Assignments the bot is still working through, in the order they arrived. */
export function openAssignments(detail: AdeBotDetail): AdeBotDetail["assignments"] {
  return detail.assignments.filter(
    (assignment) =>
      assignment.status === "queued" ||
      assignment.status === "running" ||
      assignment.status === "blocked",
  );
}

/** The one assignment the bot is actually executing, for the header strip. */
export function runningAssignment(
  detail: AdeBotDetail,
): AdeBotDetail["assignments"][number] | null {
  return detail.assignments.find((assignment) => assignment.status === "running") ?? null;
}
