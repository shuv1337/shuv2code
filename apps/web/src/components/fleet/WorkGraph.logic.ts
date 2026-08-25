/**
 * Pure view mapping for the work graph (spec §7 slice 4): a filterable list
 * and tree of assignment lineage. No canvas — lineage is `parentAssignmentId`,
 * and a tree of indented rows says everything a box-and-arrow diagram would.
 *
 * The one real decision here is what filtering means in a *tree*. Dropping
 * every non-matching node would sever the chain and leave orphans floating at
 * the root, so a node survives when it matches **or** when a descendant does;
 * the survivors that did not match themselves are marked `isContext` and the
 * component renders them muted. The flat list has no such problem and shows
 * matches only.
 */
import type {
  AdeAssignmentGraph,
  AdeAssignmentGraphNode,
  AssignmentBlockedReason,
  AssignmentId,
  AssignmentStatus,
  BotId,
} from "@shuv2code/contracts";

import type { PanelTone } from "./ProjectViewPage.logic";

/** Every §2.2 status, in lifecycle order — the filter control's order. */
export const ASSIGNMENT_STATUSES: ReadonlyArray<AssignmentStatus> = [
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

const STATUS_LABELS: Record<AssignmentStatus, string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_TONES: Record<AssignmentStatus, PanelTone> = {
  queued: "outline",
  running: "info",
  blocked: "warning",
  completed: "success",
  failed: "error",
  cancelled: "secondary",
};

const BLOCKED_REASON_LABELS: Record<AssignmentBlockedReason, string> = {
  approval: "Waiting on approval",
  children: "Waiting on children",
  "needs-resume": "Needs resume",
  "kernel-down": "Kernel down",
};

export function assignmentStatusLabel(status: AssignmentStatus): string {
  return STATUS_LABELS[status];
}

export interface WorkGraphFilter {
  /** Null means every bot. */
  readonly botId: BotId | null;
  /** Null means every status. */
  readonly status: AssignmentStatus | null;
}

export const NO_WORK_GRAPH_FILTER: WorkGraphFilter = { botId: null, status: null };

export interface WorkGraphRow {
  readonly assignmentId: AssignmentId;
  readonly parentAssignmentId: AssignmentId | null;
  /** Indentation depth in the tree; always 0 in the flat list. */
  readonly depth: number;
  readonly botId: BotId;
  readonly botName: string;
  readonly projectName: string | null;
  readonly instruction: string;
  readonly statusLabel: string;
  readonly statusTone: PanelTone;
  readonly blockedLabel: string | null;
  readonly riskLabel: string | null;
  readonly resultSummary: string | null;
  /**
   * True when the row survives only because a descendant matched the filter.
   * The component mutes these so the captain can tell context from a hit.
   */
  readonly isContext: boolean;
  /**
   * Children the tree is not drawing — either filtered out, or living outside
   * this graph's project scope (a child may be addressed to a bot on another
   * project, spec §2.2). Zero when everything is on screen.
   */
  readonly hiddenChildCount: number;
}

const matchesFilter = (node: AdeAssignmentGraphNode, filter: WorkGraphFilter): boolean =>
  (filter.botId === null || node.assignment.recipientBotId === filter.botId) &&
  (filter.status === null || node.assignment.status === filter.status);

const declaredRiskLabel = (risk: AdeAssignmentGraphNode["assignment"]["declaredRisk"]) =>
  risk === "normal" ? null : risk === "mechanical" ? "Mechanical" : "Protected";

const toRow = (
  node: AdeAssignmentGraphNode,
  depth: number,
  isContext: boolean,
  hiddenChildCount: number,
): WorkGraphRow => ({
  assignmentId: node.assignment.id,
  parentAssignmentId: node.assignment.parentAssignmentId,
  depth,
  botId: node.assignment.recipientBotId,
  botName: node.botName,
  projectName: node.projectName,
  instruction: node.assignment.instruction,
  statusLabel: STATUS_LABELS[node.assignment.status],
  statusTone: STATUS_TONES[node.assignment.status],
  blockedLabel:
    node.assignment.blockedReason === null
      ? null
      : BLOCKED_REASON_LABELS[node.assignment.blockedReason],
  riskLabel: declaredRiskLabel(node.assignment.declaredRisk),
  resultSummary:
    node.assignment.result === null || node.assignment.result.summary.trim().length === 0
      ? null
      : node.assignment.result.summary.trim(),
  isContext,
  hiddenChildCount,
});

/** Flat list: matches only, in the server's creation order. */
export function getWorkGraphListRows(
  graph: AdeAssignmentGraph | null,
  filter: WorkGraphFilter,
): ReadonlyArray<WorkGraphRow> {
  if (graph === null) return [];
  return graph.nodes
    .filter((node) => matchesFilter(node, filter))
    .map((node) => toRow(node, 0, false, 0));
}

/**
 * Depth-first pre-order rows with indentation depth. A node whose parent is
 * absent from `graph.nodes` is a root *of this scope* — the project-scoped
 * graph is full of them (the captain-requested parent may live elsewhere), and
 * dropping them would empty the tree.
 */
export function getWorkGraphTreeRows(
  graph: AdeAssignmentGraph | null,
  filter: WorkGraphFilter,
): ReadonlyArray<WorkGraphRow> {
  if (graph === null) return [];

  const byId = new Map(graph.nodes.map((node) => [node.assignment.id, node] as const));
  const childrenOf = new Map<AssignmentId, ReadonlyArray<AdeAssignmentGraphNode>>();
  const roots: AdeAssignmentGraphNode[] = [];
  for (const node of graph.nodes) {
    const parentId = node.assignment.parentAssignmentId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(node);
      continue;
    }
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), node]);
  }

  // A node is kept when it matches or when any descendant does. Memoized so a
  // wide fan-out is walked once, and guarded against a cycle in the recorded
  // lineage — a pure view function must not be able to hang the page.
  const keep = new Map<AssignmentId, boolean>();
  const visiting = new Set<AssignmentId>();
  const shouldKeep = (node: AdeAssignmentGraphNode): boolean => {
    const id = node.assignment.id;
    const memo = keep.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const kept =
      matchesFilter(node, filter) || (childrenOf.get(id) ?? []).some((child) => shouldKeep(child));
    visiting.delete(id);
    keep.set(id, kept);
    return kept;
  };

  const rows: WorkGraphRow[] = [];
  const emitted = new Set<AssignmentId>();
  const walk = (node: AdeAssignmentGraphNode, depth: number): void => {
    const id = node.assignment.id;
    if (emitted.has(id) || !shouldKeep(node)) return;
    emitted.add(id);
    const visibleChildren = (childrenOf.get(id) ?? []).filter((child) => shouldKeep(child));
    rows.push(
      toRow(
        node,
        depth,
        !matchesFilter(node, filter),
        Math.max(0, node.childCount - visibleChildren.length),
      ),
    );
    for (const child of visibleChildren) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

/** Status filter counts across the whole scope, so empty statuses still show. */
export function workGraphStatusCounts(
  graph: AdeAssignmentGraph | null,
): Record<AssignmentStatus, number> {
  const counts = Object.fromEntries(ASSIGNMENT_STATUSES.map((status) => [status, 0])) as Record<
    AssignmentStatus,
    number
  >;
  if (graph === null) return counts;
  for (const node of graph.nodes) counts[node.assignment.status] += 1;
  return counts;
}

/**
 * Whether the filter hid everything. Distinguished from "no work at all" so
 * the empty state can offer to clear the filter instead of implying the
 * project has never been given an assignment.
 */
export function workGraphIsFilteredEmpty(
  graph: AdeAssignmentGraph | null,
  rows: ReadonlyArray<WorkGraphRow>,
): boolean {
  return graph !== null && graph.nodes.length > 0 && rows.length === 0;
}
