import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { PreviewAutomationSnapshotInput } from "./previewAutomation.ts";

const decodeSnapshotInput = Schema.decodeUnknownSync(PreviewAutomationSnapshotInput);

describe("PreviewAutomationSnapshotInput", () => {
  it("accepts compact and full accessibility modes", () => {
    expect(decodeSnapshotInput({})).toEqual({});
    expect(decodeSnapshotInput({ mode: "compact" })).toEqual({ mode: "compact" });
    expect(decodeSnapshotInput({ mode: "full", tabId: "tab_1" })).toEqual({
      mode: "full",
      tabId: "tab_1",
    });
  });

  it("rejects unknown modes", () => {
    expect(() => decodeSnapshotInput({ mode: "raw" })).toThrow();
  });
});
