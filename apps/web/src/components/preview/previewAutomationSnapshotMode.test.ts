import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewAutomationSnapshotMode } from "./previewAutomationSnapshotMode";

describe("resolvePreviewAutomationSnapshotMode", () => {
  it("defaults omitted mode to compact before crossing the desktop bridge", () => {
    expect(resolvePreviewAutomationSnapshotMode({})).toBe("compact");
  });

  it("preserves explicit full diagnostics mode", () => {
    expect(resolvePreviewAutomationSnapshotMode({ mode: "full" })).toBe("full");
  });
});
