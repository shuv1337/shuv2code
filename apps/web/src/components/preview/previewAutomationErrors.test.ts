import {
  EnvironmentId,
  formatPreviewAutomationResultTooLargeBytes,
  PREVIEW_AUTOMATION_RESULT_TOO_LARGE_TAG,
  PreviewTabId,
  ThreadId,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationOperationError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors.ts";

const context = {
  requestId: "request-1",
  operation: "snapshot" as const,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  tabId: PreviewTabId.make("tab-1"),
};

describe("PreviewAutomationOperationError.fromCause", () => {
  it("keeps a desktop budget rejection typed across the renderer hop", () => {
    const bytes = {
      budget: "screenshot" as const,
      actualBytes: 640_000,
      maximumBytes: 512_000,
    };
    const error = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: new Error(
        `Error invoking remote method 'preview:automation:snapshot': ${PREVIEW_AUTOMATION_RESULT_TOO_LARGE_TAG}: Preview automation result in tab tab-1 ${formatPreviewAutomationResultTooLargeBytes(bytes)}`,
      ),
    });

    const serialized = serializePreviewAutomationHostError(error);
    expect(serialized._tag).toBe(PREVIEW_AUTOMATION_RESULT_TOO_LARGE_TAG);
    expect(serialized.detail).toMatchObject(bytes);
    expect(serialized.message).toContain("Retry without includeScreenshot");
  });

  it("still reports unrelated failures as generic operation errors", () => {
    const error = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: new Error("renderer exploded"),
    });

    expect(serializePreviewAutomationHostError(error)._tag).toBe("PreviewAutomationExecutionError");
  });

  it("preserves an evaluation budget and its recovery guidance", () => {
    const bytes = {
      budget: "evaluation" as const,
      actualBytes: 70_000,
      maximumBytes: 64_000,
    };
    const error = PreviewAutomationOperationError.fromCause({
      ...context,
      operation: "evaluate",
      cause: new Error(
        `Desktop evaluate failed: ${formatPreviewAutomationResultTooLargeBytes(bytes)}`,
      ),
    });

    const serialized = serializePreviewAutomationHostError(error);
    expect(serialized._tag).toBe(PREVIEW_AUTOMATION_RESULT_TOO_LARGE_TAG);
    expect(serialized.detail).toMatchObject(bytes);
    expect(serialized.message).toContain("Narrow the preview_evaluate expression");
  });
});
