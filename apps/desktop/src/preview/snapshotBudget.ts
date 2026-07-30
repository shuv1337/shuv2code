import type {
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotTruncatedField,
} from "@shuv2code/contracts";
import {
  PREVIEW_AUTOMATION_ACCESSIBILITY_TREE_BUDGET_REASON,
  PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH,
  PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH,
  PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
  PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
  PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
} from "@shuv2code/contracts";
import {
  type CompactAccessibilityTree,
  compactAccessibilityTree,
} from "@shuv2code/shared/compactAccessibilityTree";

export interface PreviewAutomationSnapshotBudgetFailure {
  readonly budget: "metadata" | "screenshot";
  readonly actualBytes: number;
  readonly maximumBytes: number;
}

export type PreviewAutomationSnapshotBudgetResult =
  | { readonly ok: true; readonly snapshot: PreviewAutomationSnapshot }
  | { readonly ok: false; readonly failure: PreviewAutomationSnapshotBudgetFailure };

// MCP replaces the screenshot payload with its descriptor before measuring, so
// the producer has to measure the same shape to predict the same verdict.
const metadataByteLength = (snapshot: PreviewAutomationSnapshot): number =>
  Buffer.byteLength(
    JSON.stringify({
      ...snapshot,
      screenshot:
        snapshot.screenshot === null
          ? null
          : {
              mimeType: snapshot.screenshot.mimeType,
              width: snapshot.screenshot.width,
              height: snapshot.screenshot.height,
            },
    }),
    "utf8",
  );

const encodedByteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

const budgetDroppedAccessibilityTree = (tree: unknown): CompactAccessibilityTree => {
  const compacted = compactAccessibilityTree(tree);
  return {
    mode: "compact",
    totalNodeCount: compacted.totalNodeCount,
    relevantNodeCount: compacted.relevantNodeCount,
    includedNodeCount: 0,
    truncated: true,
    nodes: [],
    unavailableReason: PREVIEW_AUTOMATION_ACCESSIBILITY_TREE_BUDGET_REASON,
  };
};

const fitAccessibilityTreeToAllowance = (
  tree: unknown,
  allowance: number,
): CompactAccessibilityTree => {
  const compacted = compactAccessibilityTree(tree);
  const { unavailableReason: _, ...summary } = compacted;
  const empty = {
    ...summary,
    includedNodeCount: 0,
    truncated: true,
    nodes: [],
  } satisfies CompactAccessibilityTree;
  const fixedBytes = encodedByteLength(empty) - 2;
  let nodesBytes = 2;
  let includedNodeCount = 0;
  for (const node of compacted.nodes) {
    const nextNodeCount = includedNodeCount + 1;
    const nextNodesBytes = nodesBytes + encodedByteLength(node) + (includedNodeCount === 0 ? 0 : 1);
    // The empty summary already accounts for the single digit in
    // includedNodeCount=0; count any additional digits before admitting a node.
    const countWidthGrowth = String(nextNodeCount).length - 1;
    if (fixedBytes + nextNodesBytes + countWidthGrowth > allowance) break;
    nodesBytes = nextNodesBytes;
    includedNodeCount = nextNodeCount;
  }
  const nodes = compacted.nodes.slice(0, includedNodeCount);
  if (nodes.length === 0) return budgetDroppedAccessibilityTree(compacted);
  return {
    ...empty,
    includedNodeCount,
    nodes,
  };
};

const fitTextToAllowance = (text: string, allowance: number): string => {
  if (allowance <= 0) return "";
  let candidate = text;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const encoded = encodedByteLength(candidate);
    if (encoded <= allowance) return candidate;
    const ratio = allowance / encoded;
    const next = Math.max(0, Math.min(candidate.length - 1, Math.floor(candidate.length * ratio)));
    candidate = candidate.slice(0, next);
    if (candidate.length === 0) return "";
  }
  return encodedByteLength(candidate) <= allowance ? candidate : "";
};

const fitElementsToAllowance = <A>(
  elements: ReadonlyArray<A>,
  allowance: number,
): ReadonlyArray<A> => {
  let used = 2;
  for (let index = 0; index < elements.length; index += 1) {
    const cost = encodedByteLength(elements[index]) + (index === 0 ? 0 : 1);
    if (used + cost > allowance) return elements.slice(0, index);
    used += cost;
  }
  return elements;
};

export const boundPreviewAutomationSnapshot = (
  snapshot: PreviewAutomationSnapshot,
): PreviewAutomationSnapshotBudgetResult => {
  const truncatedFields = new Set<PreviewAutomationSnapshotTruncatedField>();
  let current = snapshot;
  const reduce = (
    field: PreviewAutomationSnapshotTruncatedField,
    next: Partial<PreviewAutomationSnapshot>,
  ): void => {
    current = { ...current, ...next };
    truncatedFields.add(field);
  };
  const withReport = (): PreviewAutomationSnapshot =>
    truncatedFields.size === 0 ? current : { ...current, truncated: [...truncatedFields] };
  const overBudget = (): boolean =>
    metadataByteLength(withReport()) > PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES;
  const allowanceFor = (
    field: PreviewAutomationSnapshotTruncatedField,
    empty: Partial<PreviewAutomationSnapshot>,
    emptyBytes: number,
  ): number => {
    truncatedFields.add(field);
    const withoutField = metadataByteLength({
      ...current,
      ...empty,
      truncated: [...truncatedFields],
    });
    return PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES - withoutField + emptyBytes;
  };

  if (current.url.length > PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH) {
    reduce("url", { url: current.url.slice(0, PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH) });
  }
  if (current.title.length > PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH) {
    reduce("title", { title: current.title.slice(0, PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH) });
  }
  if (current.screenshot !== null) {
    const imageBytes = Buffer.byteLength(current.screenshot.data, "base64");
    if (imageBytes > PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        failure: {
          budget: "screenshot",
          actualBytes: imageBytes,
          maximumBytes: PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
        },
      };
    }
  }

  // Ordered least-valuable first: stale diagnostics, then accessibility detail,
  // then page prose, and only last the locators an agent acts on.
  if (overBudget()) {
    if (current.consoleEntries.length > PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT) {
      reduce("consoleEntries", {
        consoleEntries: current.consoleEntries.slice(
          -PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
        ),
      });
    }
    if (current.networkEntries.length > PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT) {
      reduce("networkEntries", {
        networkEntries: current.networkEntries.slice(
          -PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
        ),
      });
    }
    if (current.actionTimeline.length > PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT) {
      reduce("actionTimeline", {
        actionTimeline: current.actionTimeline.slice(
          -PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
        ),
      });
    }
  }
  if (overBudget()) {
    const compacted = compactAccessibilityTree(current.accessibilityTree);
    if (encodedByteLength(compacted) < encodedByteLength(current.accessibilityTree)) {
      reduce("accessibilityTree", { accessibilityTree: compacted });
    }
  }
  if (overBudget()) {
    const empty = budgetDroppedAccessibilityTree(current.accessibilityTree);
    const allowance = allowanceFor(
      "accessibilityTree",
      { accessibilityTree: empty },
      encodedByteLength(empty),
    );
    const fitted = fitAccessibilityTreeToAllowance(current.accessibilityTree, allowance);
    if (encodedByteLength(fitted) < encodedByteLength(current.accessibilityTree)) {
      reduce("accessibilityTree", { accessibilityTree: fitted });
    }
  }
  if (overBudget() && current.visibleText.length > 0) {
    const allowance = allowanceFor("visibleText", { visibleText: "" }, 2);
    reduce("visibleText", { visibleText: fitTextToAllowance(current.visibleText, allowance) });
  }
  if (overBudget() && current.interactiveElements.length > 0) {
    const allowance = allowanceFor("interactiveElements", { interactiveElements: [] }, 2);
    reduce("interactiveElements", {
      interactiveElements: fitElementsToAllowance(current.interactiveElements, allowance),
    });
  }

  const bounded = withReport();
  const metadataBytes = metadataByteLength(bounded);
  return metadataBytes > PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES
    ? {
        ok: false,
        failure: {
          budget: "metadata",
          actualBytes: metadataBytes,
          maximumBytes: PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
        },
      }
    : { ok: true, snapshot: bounded };
};
