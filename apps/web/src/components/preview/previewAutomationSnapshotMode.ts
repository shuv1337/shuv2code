import type {
  PreviewAutomationSnapshotInput,
  PreviewAutomationSnapshotMode,
} from "@shuv2code/contracts";

export const resolvePreviewAutomationSnapshotMode = (
  input: PreviewAutomationSnapshotInput,
): PreviewAutomationSnapshotMode => input.mode ?? "compact";
