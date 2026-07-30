import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PREVIEW_AUTOMATION_MAX_DIAGNOSTIC_TEXT_LENGTH,
  PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
} from "./previewAutomation.ts";

const decodeSnapshotInput = Schema.decodeUnknownSync(PreviewAutomationSnapshotInput);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);

describe("PreviewAutomationSnapshotInput", () => {
  it("accepts compact and full accessibility modes", () => {
    expect(decodeSnapshotInput({})).toEqual({});
    expect(decodeSnapshotInput({ mode: "compact" })).toEqual({ mode: "compact" });
    expect(decodeSnapshotInput({ mode: "full", tabId: "tab_1" })).toEqual({
      mode: "full",
      tabId: "tab_1",
    });
  });

  it("keeps screenshots explicit instead of charging semantic snapshots by default", () => {
    expect(decodeSnapshotInput({})).toEqual({});
    expect(decodeSnapshotInput({ includeScreenshot: true })).toEqual({ includeScreenshot: true });
    expect(decodeSnapshotInput({ mode: "compact", includeScreenshot: true })).toEqual({
      mode: "compact",
      includeScreenshot: true,
    });
  });

  it("rejects unknown modes", () => {
    expect(() => decodeSnapshotInput({ mode: "raw" })).toThrow();
  });
});

describe("PreviewAutomationSnapshot budgets", () => {
  const baseSnapshot = {
    url: "https://example.test",
    title: "Example",
    loading: false,
    visibleText: "Example",
    accessibilityTree: {},
    networkEntries: [],
    actionTimeline: [],
    screenshot: null,
  };

  it("rejects one oversized interactive name despite a bounded element count", () => {
    expect(() =>
      decodeSnapshot({
        ...baseSnapshot,
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "x".repeat(PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH + 1),
            selector: "button",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ],
        consoleEntries: [],
      }),
    ).toThrow();
  });

  it("rejects a single oversized diagnostic entry", () => {
    expect(() =>
      decodeSnapshot({
        ...baseSnapshot,
        interactiveElements: [],
        consoleEntries: [
          {
            level: "log",
            text: "x".repeat(PREVIEW_AUTOMATION_MAX_DIAGNOSTIC_TEXT_LENGTH + 1),
            timestamp: "2026-07-30T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });
});
