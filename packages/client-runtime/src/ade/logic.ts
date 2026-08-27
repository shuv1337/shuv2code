import type {
  AdeBotDetail,
  AdeCaptainError,
  BotExecutionBinding,
  BotStructuralRole,
  FleetHealthSnapshot,
} from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "../connection/index.ts";

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
  /*
   * Cause-neutral on purpose.
   *
   * `session_unavailable` is a *bucket*: the server raises it for a missing
   * project, a project with no repository path, a failed workspace create, a
   * kernel that is down, and a provider instance with no usable models. An
   * earlier cut of #217 headlined it "check its provider settings", which is
   * confidently wrong for most of those causes and actively contradicts the
   * no-project CTA it can render directly above.
   *
   * The headline therefore states only what is certainly true. The actual
   * remedy is already named by the server's own message, which rides in the
   * detail half of `adeCaptainErrorParts` and surfaces in the notice's
   * disclosure.
   */
  session_unavailable: "This bot isn't connected.",
  // The kernel is up; its catalog is the problem. The `opencode.json` remedy
  // rides the detail half, like every other technical remediation here.
  model_not_agent_capable: "No model on this kernel can run this bot.",
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
  // Organizational, not destructive: both of these leave every bot exactly
  // where it was, so the sentence says what to change rather than what broke.
  bot_group_not_found: "That group no longer exists — pick another.",
  bot_group_name_conflict: "A group with that name already exists.",
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

/**
 * The same error, split rather than concatenated (#217).
 *
 * `adeCaptainErrorMessage` glues the closed-reason sentence onto the server's
 * message, which is how a captain ended up reading "No kernel session is
 * available right now. No 'opencode2' provider instance is configured. Add one
 * in Settings → Providers (point Binary path at your shuvcode CLI)…" as
 * primary UI copy. The headline is the part a captain reads at a glance; the
 * detail is technical remediation and belongs behind a disclosure. Callers that
 * genuinely want one string (toasts, `role="alert"` one-liners) keep using
 * `adeCaptainErrorMessage`, which is now defined in terms of this.
 */
export interface AdeCaptainErrorParts {
  readonly headline: string;
  readonly details: string | null;
}

export function adeCaptainErrorParts(error: unknown, fallback: string): AdeCaptainErrorParts {
  const reason = adeCaptainErrorReason(error);
  const raw = (error as { readonly message?: unknown } | null)?.message;
  const detail = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  if (reason !== null) {
    return { headline: CAPTAIN_ERROR_TEXT[reason], details: detail };
  }
  return error instanceof Error && error.message.trim().length > 0
    ? { headline: fallback, details: error.message }
    : { headline: fallback, details: null };
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
