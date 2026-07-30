import type {
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotTruncatedField,
} from "@shuv2code/contracts";
import {
  PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH,
  PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH,
  PREVIEW_AUTOMATION_SNAPSHOT_DIAGNOSTIC_ENTRY_LIMIT,
  PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
  PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
} from "@shuv2code/contracts";
import { compactAccessibilityTree } from "@shuv2code/shared/compactAccessibilityTree";

export interface BoundedPreviewAutomationSnapshot {
  readonly snapshot: PreviewAutomationSnapshot;
  readonly metadataBytes: number;
  readonly withinBudget: boolean;
}

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

export const boundPreviewAutomationSnapshot = (
  snapshot: PreviewAutomationSnapshot,
): BoundedPreviewAutomationSnapshot => {
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
  const fits = (): boolean =>
    metadataByteLength(withReport()) <= PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES;

  if (current.url.length > PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH) {
    reduce("url", { url: current.url.slice(0, PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH) });
  }
  if (current.title.length > PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH) {
    reduce("title", { title: current.title.slice(0, PREVIEW_AUTOMATION_MAX_PAGE_TITLE_LENGTH) });
  }
  if (
    current.screenshot !== null &&
    Buffer.byteLength(current.screenshot.data, "base64") >
      PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES
  ) {
    reduce("screenshot", { screenshot: null });
  }

  // Ordered least-valuable first: stale diagnostics, then raw accessibility
  // detail, then page prose, and only then the locators an agent acts on.
  if (!fits()) {
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
  if (!fits()) {
    const compacted = compactAccessibilityTree(current.accessibilityTree);
    const encodedLength = (tree: unknown): number => (JSON.stringify(tree) ?? "").length;
    if (encodedLength(compacted) < encodedLength(current.accessibilityTree)) {
      reduce("accessibilityTree", { accessibilityTree: compacted });
    }
  }
  while (current.visibleText.length > 0 && !fits()) {
    reduce("visibleText", {
      visibleText: current.visibleText.slice(0, Math.floor(current.visibleText.length / 2)),
    });
  }
  while (current.interactiveElements.length > 0 && !fits()) {
    reduce("interactiveElements", {
      interactiveElements: current.interactiveElements.slice(
        0,
        Math.floor(current.interactiveElements.length / 2),
      ),
    });
  }
  if (!fits()) {
    reduce("accessibilityTree", { accessibilityTree: null });
  }

  const bounded = withReport();
  const metadataBytes = metadataByteLength(bounded);
  return {
    snapshot: bounded,
    metadataBytes,
    withinBudget: metadataBytes <= PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
  };
};
