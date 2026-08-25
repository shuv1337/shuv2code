/**
 * Needs You projection (spec `docs/ade/ADE-V1-SPEC.md` §7 slice 5 — S13).
 *
 * The durable item is deliberately thin: a kind, some subject refs, a status
 * (spec §2.5). Everything a captain actually reads — what is waiting, on what,
 * and what happens next — is derived, and it is derived *here*, on the server,
 * for one reason: the item renders twice (inbox and inline). Two renderings
 * that each invent their own sentence are two descriptions of one fact, and
 * they drift. One projection, two renderings.
 *
 * Pure and row-shaped so it can be tested without a database.
 */
import type {
  AdeNeedsYouEntry,
  AdeProjectId,
  AssignmentId,
  BotId,
  IntegrationCandidateId,
  KernelEngine,
  NeedsYouItem,
  NeedsYouAction,
  NeedsYouItemId,
  NeedsYouKind,
  NeedsYouItemStatus,
} from "@shuv2code/contracts";

export interface NeedsYouRow {
  readonly needs_you_item_id: string;
  readonly kind: NeedsYouKind;
  readonly subject_refs_json: string;
  readonly status: NeedsYouItemStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
  /**
   * 1 when the captain's decision carried a note (migration 059). The *value*
   * is never stored — a `form` note is withheld entirely — so this flag is the
   * only thing that distinguishes an answered item from a dismissed one. Not
   * projected to the client: it is an audit fact, not something a card reads.
   */
  readonly resolution_note_present?: number;
}

/** Names the projection needs to say something a human recognizes. */
export interface NeedsYouNaming {
  readonly botNames: ReadonlyMap<string, string>;
  readonly projectNames: ReadonlyMap<string, string>;
  /** Assignment id → instruction, used for the one-line stall subject. */
  readonly assignmentInstructions: ReadonlyMap<string, string>;
}

export const emptyNeedsYouNaming: NeedsYouNaming = {
  botNames: new Map(),
  projectNames: new Map(),
  assignmentInstructions: new Map(),
};

interface FlatSubjects {
  readonly botId: string | null;
  readonly projectId: string | null;
  readonly assignmentId: string | null;
  readonly integrationCandidateId: string | null;
  readonly kernelEngine: string | null;
}

const NO_SUBJECTS: FlatSubjects = {
  botId: null,
  projectId: null,
  assignmentId: null,
  integrationCandidateId: null,
  kernelEngine: null,
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Tolerant on purpose. A subject-ref blob is written by five different
 * services (§4.4, §4.6, §4.8, S7) across schema generations; an item the
 * captain cannot parse must still be *visible*, because the alternative is a
 * badge counting something the inbox refuses to show.
 */
export function flattenSubjectRefs(raw: string): FlatSubjects {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_SUBJECTS;
  }
  if (!Array.isArray(parsed)) return NO_SUBJECTS;
  // First ref of each kind wins; a well-formed item never carries two of one
  // kind, and a malformed one is not worth a merge policy.
  let botId: string | null = null;
  let projectId: string | null = null;
  let assignmentId: string | null = null;
  let integrationCandidateId: string | null = null;
  let kernelEngine: string | null = null;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const ref = entry as Record<string, unknown>;
    switch (ref._tag) {
      case "bot":
        botId ??= readString(ref.botId);
        break;
      case "project":
        projectId ??= readString(ref.projectId);
        break;
      case "assignment":
        assignmentId ??= readString(ref.assignmentId);
        break;
      case "integrationCandidate":
        integrationCandidateId ??= readString(ref.integrationCandidateId);
        break;
      case "kernel":
        kernelEngine ??= readString(ref.engine);
        break;
      default:
        break;
    }
  }
  return { botId, projectId, assignmentId, integrationCandidateId, kernelEngine };
}

const KERNEL_LABELS: Readonly<Record<string, string>> = {
  shuvcode: "The shuvcode service",
  codex: "The Codex supervisor",
};

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * An **unroutable repair**: the integration service bounced a change, went to
 * assign the repair back to its author, and found nobody to assign it to
 * (ADR §7.2, §13.3). It files a `stall` item naming only the candidate.
 *
 * That shape has to be told apart from an ordinary stall, twice over. It reads
 * nothing like one — there is no bot to steer and no assignment to cancel — and
 * more importantly nothing will ever clear it: the assignment engine's stall
 * resolver keys on an assignment id this item does not carry, so left alone it
 * counts on the badge forever. It is the one item the captain retires by hand.
 */
const isUnroutableRepair = (kind: NeedsYouKind, flat: FlatSubjects): boolean =>
  kind === "stall" && flat.integrationCandidateId !== null && flat.assignmentId === null;

/**
 * An **undelivered voice-call summary** (§4.7, S16): the end-of-call summary
 * is durable on the bot's closed voice binding, but the kernel refused it for
 * long enough that the retry budget ran out. It files a `stall` naming only
 * the bot.
 *
 * Like the unroutable repair, nothing will ever clear it — there is no
 * assignment for the stall resolver to key on — so it is the captain's to
 * retire once they have read the summary.
 */
const isUndeliveredVoiceSummary = (kind: NeedsYouKind, flat: FlatSubjects): boolean =>
  kind === "stall" &&
  flat.botId !== null &&
  flat.assignmentId === null &&
  flat.integrationCandidateId === null;

/**
 * What the captain can press. Approval is the only kind anything *waits* on;
 * every other kind is resolved by the service that raised it once the condition
 * clears (§4.6, §4.8) — except the two stall shapes above and `form`, which
 * nothing clears. A resolved item offers nothing, however it got there.
 *
 * **`form` is `acknowledge`** (MESSENGER-PIVOT §6 M5). A form item is a request
 * for a value the captain types; no service can ever satisfy it, so left
 * without an action it counts on the badge forever — the same trap the two
 * stall shapes describe. `acknowledge` is the right control rather than
 * `approve-deny` because there is no verdict to forward and no candidate to
 * forward it to: the captain's answer retires the item and travels no further.
 * That last part is deliberate and enforced in `submitNeedsYouDecision`, not
 * incidental — see the note-withholding guard there.
 */
export function needsYouActionFor(
  row: Pick<NeedsYouRow, "kind" | "status">,
  flat: FlatSubjects,
): NeedsYouAction | null {
  if (row.status !== "open") return null;
  if (row.kind === "approval") return "approve-deny";
  if (row.kind === "form") return "acknowledge";
  return isUnroutableRepair(row.kind, flat) || isUndeliveredVoiceSummary(row.kind, flat)
    ? "acknowledge"
    : null;
}

function describe(
  row: NeedsYouRow,
  flat: FlatSubjects,
  naming: NeedsYouNaming,
): { readonly title: string; readonly detail: string } {
  const botName =
    flat.botId === null ? null : (naming.botNames.get(flat.botId) ?? "An archived bot");
  const projectName =
    flat.projectId === null ? null : (naming.projectNames.get(flat.projectId) ?? null);
  switch (row.kind) {
    case "approval":
      return {
        title:
          projectName === null
            ? "A change is waiting for your approval"
            : `${projectName}: a change is waiting for your approval`,
        detail:
          botName === null
            ? "Approving integrates it; denying bounces it back for repair."
            : `${botName}'s change passed its checks. Approving integrates it; denying bounces it back for repair.`,
      };
    case "kernel-down":
      return {
        title: `${KERNEL_LABELS[flat.kernelEngine ?? ""] ?? "A kernel"} is not responding`,
        detail:
          "Work on that kernel is blocked rather than failed, and resumes on its own when the kernel comes back.",
      };
    case "stall": {
      if (isUnroutableRepair(row.kind, flat)) {
        // Say the actual thing. "A bot has gone quiet — steer it or cancel the
        // assignment" names a bot that is gone and an assignment that does not
        // exist, which sends the captain looking for controls that are not
        // there.
        const project = projectName === null ? "A change" : `A change in ${projectName}`;
        return {
          title: "A bounced change cannot be repaired automatically",
          detail: `${project} bounced, and its author bot is archived or gone, so no repair could be assigned. Review integration candidate ${flat.integrationCandidateId ?? "(unknown)"} yourself, then acknowledge this to clear it.`,
        };
      }
      if (isUndeliveredVoiceSummary(row.kind, flat)) {
        // Same rule as above: say the actual thing. There is no assignment to
        // cancel and no bot to steer — the summary is already written down.
        const who = botName ?? "A bot";
        return {
          title: `${who}'s voice call summary could not be delivered`,
          detail: `The summary is saved on that call's session record, but the kernel would not accept it into ${botName ?? "the bot"}'s primary session. Read it there, then acknowledge this to clear it.`,
        };
      }
      const instruction =
        flat.assignmentId === null
          ? null
          : (naming.assignmentInstructions.get(flat.assignmentId) ?? null);
      return {
        title:
          botName === null
            ? "An assignment has gone quiet"
            : `${botName} has gone quiet on an assignment`,
        detail:
          instruction === null
            ? "Nothing has moved on it for a while. Steer the bot or cancel the assignment."
            : `Nothing has moved on “${truncate(instruction, 120)}” for a while. Steer the bot or cancel the assignment.`,
      };
    }
    case "provision-failure":
      return {
        title:
          botName === null
            ? "A desktop could not be provisioned"
            : `${botName}'s desktop could not be provisioned`,
        detail:
          "Computer use is unavailable for that bot until Screenbox provisions it. Retrying happens on the next tool call.",
      };
    case "form":
      return {
        title:
          botName === null ? "A bot is asking you something" : `${botName} is asking you something`,
        detail: "Open the bot's conversation to answer.",
      };
  }
}

export function rowToNeedsYouItem(row: NeedsYouRow): NeedsYouItem {
  return {
    id: row.needs_you_item_id as NeedsYouItemId,
    kind: row.kind,
    subjectRefs: [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function projectNeedsYouRow(row: NeedsYouRow, naming: NeedsYouNaming): AdeNeedsYouEntry {
  const flat = flattenSubjectRefs(row.subject_refs_json);
  const { title, detail } = describe(row, flat, naming);
  const subjectRefs: NeedsYouItem["subjectRefs"] = [
    ...(flat.botId === null ? [] : [{ _tag: "bot" as const, botId: flat.botId as BotId }]),
    ...(flat.projectId === null
      ? []
      : [{ _tag: "project" as const, projectId: flat.projectId as AdeProjectId }]),
    ...(flat.assignmentId === null
      ? []
      : [{ _tag: "assignment" as const, assignmentId: flat.assignmentId as AssignmentId }]),
    ...(flat.integrationCandidateId === null
      ? []
      : [
          {
            _tag: "integrationCandidate" as const,
            integrationCandidateId: flat.integrationCandidateId as IntegrationCandidateId,
          },
        ]),
    ...(flat.kernelEngine === null
      ? []
      : [{ _tag: "kernel" as const, engine: flat.kernelEngine as KernelEngine }]),
  ];
  const action = needsYouActionFor(row, flat);
  return {
    item: { ...rowToNeedsYouItem(row), subjectRefs },
    title,
    detail,
    actionable: action !== null,
    action,
    botId: flat.botId as BotId | null,
    projectId: flat.projectId as AdeProjectId | null,
    assignmentId: flat.assignmentId as AssignmentId | null,
    integrationCandidateId: flat.integrationCandidateId as IntegrationCandidateId | null,
    kernelEngine: flat.kernelEngine as KernelEngine | null,
  };
}

/**
 * Inbox order: things you can act on, then everything else still open, then
 * what is already done — newest first inside each band. A captain opening the
 * inbox is looking for the decision that is blocking work, not for a
 * chronological log.
 */
export function compareNeedsYouEntries(left: AdeNeedsYouEntry, right: AdeNeedsYouEntry): number {
  const band = (entry: AdeNeedsYouEntry): number =>
    entry.actionable ? 0 : entry.item.status === "open" ? 1 : 2;
  const byBand = band(left) - band(right);
  if (byBand !== 0) return byBand;
  const byRecency = right.item.createdAt.localeCompare(left.item.createdAt);
  return byRecency !== 0 ? byRecency : left.item.id.localeCompare(right.item.id);
}
