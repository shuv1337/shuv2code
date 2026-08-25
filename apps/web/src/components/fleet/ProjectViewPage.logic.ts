/**
 * Pure view mapping for the ADE project view (spec §7 slice 3): the three
 * stacked panels — crew, integration queue, publication stack.
 *
 * The server owns every ordering decision (crew rank, queue order, layer
 * order), so nothing here re-sorts. What it owns is vocabulary: turning the
 * §2.3/§2.4 status unions into the words and tones a panel prints, and the
 * queue's client-side status filter — client-side because the filter chips
 * have to say how many candidates each status holds, which a server-filtered
 * list cannot answer.
 */
import type {
  AdeProjectCrewMember,
  AdeProjectDetail,
  AdePublicationStackView,
  AssignmentId,
  BotId,
  IntegrationCandidate,
  IntegrationCandidateStatus,
  IntegrationPolicy,
  PublicationLayer,
  PublicationLayerId,
  PublicationStackId,
} from "@shuv2code/contracts";

import { structuralRoleLabel } from "../../state/ade.logic";

/** Semantic `Badge` tones, kept as a closed union so components stay thin. */
export type PanelTone =
  | "default"
  | "secondary"
  | "outline"
  | "info"
  | "success"
  | "warning"
  | "error";

// ---------------------------------------------------------------------------
// Panel 1 — crew
// ---------------------------------------------------------------------------

export interface ProjectCrewRowView {
  readonly botId: BotId;
  readonly name: string;
  readonly roleLabel: string;
  readonly roleTag: string;
  /** The project's Second Mate is pinned and marked; it is never archivable. */
  readonly isSecondMate: boolean;
  readonly openAssignmentLabel: string | null;
  /** A warm session is resumed rather than started (spec §4.1 lazy sessions). */
  readonly chatLabel: string;
}

export function getProjectCrewRowView(member: AdeProjectCrewMember): ProjectCrewRowView {
  return {
    botId: member.bot.id,
    name: member.bot.name,
    roleLabel: structuralRoleLabel(member.bot.structuralRole),
    roleTag: member.bot.roleTag,
    isSecondMate: member.isSecondMate,
    openAssignmentLabel:
      member.openAssignmentCount <= 0
        ? null
        : member.openAssignmentCount === 1
          ? "1 open assignment"
          : `${member.openAssignmentCount} open assignments`,
    chatLabel: member.hasActivePrimarySession ? "Resume chat" : "Chat",
  };
}

export function getProjectCrewRowViews(
  detail: AdeProjectDetail | null,
): ReadonlyArray<ProjectCrewRowView> {
  return detail === null ? [] : detail.crew.map(getProjectCrewRowView);
}

const INTEGRATION_POLICY_LABELS: Record<IntegrationPolicy, string> = {
  automatic: "Automatic",
  "agent-review": "Agent review",
  "human-approval": "Human approval",
};

export function integrationPolicyLabel(policy: IntegrationPolicy): string {
  return INTEGRATION_POLICY_LABELS[policy];
}

export interface ProjectHeaderView {
  readonly name: string;
  /**
   * A project with no repo binding can never integrate or publish (ADR §14),
   * so the header says so rather than leaving two empty panels unexplained.
   */
  readonly repoLabel: string;
  readonly isRepoBound: boolean;
  readonly policyLabel: string;
  readonly checkCommandsLabel: string;
}

export function getProjectHeaderView(detail: AdeProjectDetail | null): ProjectHeaderView | null {
  if (detail === null) return null;
  const binding = detail.project.repoBinding;
  return {
    name: detail.project.name,
    repoLabel: binding === null ? "No repository bound" : binding.path,
    isRepoBound: binding !== null,
    policyLabel: integrationPolicyLabel(detail.project.integrationPolicyDefault),
    checkCommandsLabel:
      detail.project.checkCommands.length === 0
        ? "No check commands"
        : detail.project.checkCommands.join(" · "),
  };
}

// ---------------------------------------------------------------------------
// Panel 2 — integration queue
// ---------------------------------------------------------------------------

/** Every §2.3 candidate status, in pipeline order — the chip row's order. */
export const CANDIDATE_STATUSES: ReadonlyArray<IntegrationCandidateStatus> = [
  "queued",
  "running",
  "awaiting-review",
  "awaiting-approval",
  "integrated",
  "bounced",
];

const CANDIDATE_STATUS_LABELS: Record<IntegrationCandidateStatus, string> = {
  queued: "Queued",
  running: "Running",
  "awaiting-review": "Awaiting review",
  "awaiting-approval": "Awaiting approval",
  integrated: "Integrated",
  bounced: "Bounced",
};

const CANDIDATE_STATUS_TONES: Record<IntegrationCandidateStatus, PanelTone> = {
  queued: "outline",
  running: "info",
  // Both gates are parked work waiting on a human or a reviewer, not failures.
  "awaiting-review": "warning",
  "awaiting-approval": "warning",
  integrated: "success",
  bounced: "error",
};

export function candidateStatusLabel(status: IntegrationCandidateStatus): string {
  return CANDIDATE_STATUS_LABELS[status];
}

const BOUNCE_REASON_LABELS: Record<NonNullable<IntegrationCandidate["bounce"]>["reason"], string> =
  {
    "rebase-conflict": "Rebase conflict",
    "checks-failed": "Checks failed",
    "review-rejected": "Review rejected",
    "approval-denied": "Approval denied",
  };

export interface CandidateRowView {
  readonly candidateId: IntegrationCandidate["id"];
  readonly statusLabel: string;
  readonly statusTone: PanelTone;
  /** The effective gate, once the candidate has reached its gate step. */
  readonly gateLabel: string | null;
  /**
   * The durable verdict recorded *before* it was acted on (spec §2.3). Shown
   * alongside the status because an approved candidate sits back on `running`,
   * and without this the panel would look like nothing had happened.
   */
  readonly verdictLabel: string | null;
  readonly verdictDetail: string | null;
  readonly bounceLabel: string | null;
  readonly bounceDetail: string | null;
  /** `Bounced twice` is the signal that a repair loop is not converging. */
  readonly bounceCountLabel: string | null;
  readonly changeIdsLabel: string;
  readonly changeIdCount: number;
  readonly sourceAssignmentIds: ReadonlyArray<AssignmentId>;
  readonly repairAssignmentId: AssignmentId | null;
  readonly reviewerBotId: BotId | null;
  readonly isQueueHead: boolean;
}

/**
 * `isQueueHead` marks the one candidate the integration service will act on
 * next: the running one if a pass is live, otherwise the oldest unsettled row.
 * Only one candidate per project can run (ADR §16.2), so this never ties.
 */
const SETTLED: ReadonlyArray<IntegrationCandidateStatus> = new Set(["integrated", "bounced"]);

export function queueHeadId(
  candidates: ReadonlyArray<IntegrationCandidate>,
): IntegrationCandidate["id"] | null {
  const running = candidates.find((candidate) => candidate.status === "running");
  if (running !== undefined) return running.id;
  return candidates.find((candidate) => !SETTLED.has(candidate.status))?.id ?? null;
}

export function getCandidateRowView(
  candidate: IntegrationCandidate,
  headId: IntegrationCandidate["id"] | null,
): CandidateRowView {
  return {
    candidateId: candidate.id,
    statusLabel: CANDIDATE_STATUS_LABELS[candidate.status],
    statusTone: CANDIDATE_STATUS_TONES[candidate.status],
    gateLabel: candidate.gate === null ? null : INTEGRATION_POLICY_LABELS[candidate.gate],
    verdictLabel:
      candidate.verdict === null
        ? null
        : candidate.verdict === "approved"
          ? "Approved"
          : "Rejected",
    verdictDetail: nonEmpty(candidate.verdictDetail),
    bounceLabel: candidate.bounce === null ? null : BOUNCE_REASON_LABELS[candidate.bounce.reason],
    bounceDetail: candidate.bounce === null ? null : nonEmpty(candidate.bounce.detail),
    bounceCountLabel:
      candidate.bounceCount <= 0
        ? null
        : candidate.bounceCount === 1
          ? "Bounced once"
          : `Bounced ${candidate.bounceCount} times`,
    changeIdsLabel: candidate.changeIds.join(", "),
    changeIdCount: candidate.changeIds.length,
    sourceAssignmentIds: candidate.sourceAssignmentIds,
    repairAssignmentId: candidate.repairAssignmentId,
    reviewerBotId: candidate.reviewerBotId,
    isQueueHead: candidate.id === headId,
  };
}

const nonEmpty = (value: string | null): string | null =>
  value === null || value.trim().length === 0 ? null : value.trim();

/** Chip counts. Every status is present, including the ones holding nothing. */
export function candidateStatusCounts(
  candidates: ReadonlyArray<IntegrationCandidate>,
): Record<IntegrationCandidateStatus, number> {
  const counts = Object.fromEntries(CANDIDATE_STATUSES.map((status) => [status, 0])) as Record<
    IntegrationCandidateStatus,
    number
  >;
  for (const candidate of candidates) counts[candidate.status] += 1;
  return counts;
}

export function getCandidateRowViews(
  candidates: ReadonlyArray<IntegrationCandidate>,
  status: IntegrationCandidateStatus | null,
): ReadonlyArray<CandidateRowView> {
  // The head is computed over the *whole* queue, not the filtered slice: the
  // head is a fact about the pipeline, not about what the captain is looking at.
  const headId = queueHeadId(candidates);
  return candidates
    .filter((candidate) => status === null || candidate.status === status)
    .map((candidate) => getCandidateRowView(candidate, headId));
}

// ---------------------------------------------------------------------------
// Panel 3 — publication stack
// ---------------------------------------------------------------------------

const STACK_STATUS_LABELS: Record<AdePublicationStackView["stack"]["status"], string> = {
  building: "Building",
  "review-frozen": "Review frozen",
  merging: "Merging",
  merged: "Merged",
  reconciled: "Reconciled",
};

const STACK_STATUS_TONES: Record<AdePublicationStackView["stack"]["status"], PanelTone> = {
  building: "info",
  "review-frozen": "warning",
  merging: "info",
  merged: "success",
  reconciled: "success",
};

const LAYER_STATUS_LABELS: Record<PublicationLayer["status"], string> = {
  pending: "Pending",
  submitted: "Submitted",
  merged: "Merged",
};

const PR_STATE_LABELS: Record<NonNullable<PublicationLayer["prState"]>, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

const PR_STATE_TONES: Record<NonNullable<PublicationLayer["prState"]>, PanelTone> = {
  open: "info",
  closed: "secondary",
  merged: "success",
};

export interface PublicationLayerRowView {
  readonly layerId: PublicationLayerId;
  readonly orderLabel: string;
  readonly bookmarkName: string;
  readonly prLabel: string;
  readonly prState: string | null;
  readonly prTone: PanelTone;
  readonly statusLabel: string;
  readonly changeIdsLabel: string;
  /**
   * Change ids are invalid once a layer merges (spec §2.4) — the recorded SHAs
   * are the only durable handle, so a merged row shows those instead.
   */
  readonly shaLabel: string | null;
}

export interface PublicationStackView {
  readonly stackId: PublicationStackId;
  readonly statusLabel: string;
  readonly statusTone: PanelTone;
  readonly modeLabel: string;
  readonly stackUrl: string | null;
  /** Presentation only, per ADR §8.3 — never a key. */
  readonly nativeStackLabel: string | null;
  readonly layers: ReadonlyArray<PublicationLayerRowView>;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

export function getPublicationLayerRowView(layer: PublicationLayer): PublicationLayerRowView {
  const prState = layer.prState;
  const merged = layer.mergeSha;
  return {
    layerId: layer.id,
    orderLabel: `#${layer.order + 1}`,
    bookmarkName: layer.bookmarkName,
    prLabel: layer.prNumber === null ? "No PR yet" : `PR #${layer.prNumber}`,
    prState: prState === null ? null : PR_STATE_LABELS[prState],
    prTone: prState === null ? "outline" : PR_STATE_TONES[prState],
    statusLabel: LAYER_STATUS_LABELS[layer.status],
    changeIdsLabel: layer.changeIds.join(", "),
    shaLabel:
      merged !== null
        ? `merged ${shortSha(merged)}`
        : layer.submittedSha !== null
          ? `submitted ${shortSha(layer.submittedSha)}`
          : layer.headSha !== null
            ? `head ${shortSha(layer.headSha)}`
            : null,
  };
}

export function getPublicationStackView(
  view: AdePublicationStackView | null | undefined,
): PublicationStackView | null {
  if (view === null || view === undefined) return null;
  return {
    stackId: view.stack.id,
    statusLabel: STACK_STATUS_LABELS[view.stack.status],
    statusTone: STACK_STATUS_TONES[view.stack.status],
    modeLabel: view.stack.mode === "native-stack" ? "Native stack" : "Chained",
    stackUrl: view.stack.stackUrl,
    nativeStackLabel:
      view.stack.nativeStackNumber === null ? null : `Stack #${view.stack.nativeStackNumber}`,
    layers: view.layers.map(getPublicationLayerRowView),
  };
}
