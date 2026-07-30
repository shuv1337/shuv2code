import type { PreviewAutomationSnapshot } from "@shuv2code/contracts";
import {
  PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH,
  PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH,
  PREVIEW_AUTOMATION_MAX_SELECTOR_LENGTH,
  PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
  PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
} from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundPreviewAutomationSnapshot } from "./snapshotBudget.ts";

const snapshot = (
  overrides: Partial<PreviewAutomationSnapshot> = {},
): PreviewAutomationSnapshot => ({
  url: "https://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: { nodes: [] },
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: null,
  ...overrides,
});

const measure = (bounded: PreviewAutomationSnapshot): number =>
  Buffer.byteLength(
    JSON.stringify({
      ...bounded,
      screenshot:
        bounded.screenshot === null
          ? null
          : {
              mimeType: bounded.screenshot.mimeType,
              width: bounded.screenshot.width,
              height: bounded.screenshot.height,
            },
    }),
    "utf8",
  );

describe("boundPreviewAutomationSnapshot", () => {
  it("leaves an in-budget snapshot untouched", () => {
    const bounded = boundPreviewAutomationSnapshot(snapshot());
    expect(bounded.withinBudget).toBe(true);
    expect(bounded.snapshot.truncated).toBeUndefined();
    expect(bounded.snapshot).toEqual(snapshot());
  });

  it("keeps the producer worst case inside the budget MCP assembly enforces", () => {
    const bounded = boundPreviewAutomationSnapshot(
      snapshot({
        visibleText: "v".repeat(20_000),
        interactiveElements: Array.from({ length: 200 }, (_, index) => ({
          tag: "button",
          role: "button",
          name: "n".repeat(PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH),
          selector: `s${index}`.padEnd(PREVIEW_AUTOMATION_MAX_SELECTOR_LENGTH, "x"),
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, (_, index) => ({
          level: "log",
          text: `console-${index}`.padEnd(4_096, "x"),
          timestamp: "2026-07-30T00:00:00.000Z",
        })),
      }),
    );

    expect(bounded.withinBudget).toBe(true);
    expect(measure(bounded.snapshot)).toBeLessThanOrEqual(
      PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
    );
    expect(bounded.snapshot.truncated).toEqual(
      expect.arrayContaining(["consoleEntries", "interactiveElements"]),
    );
    expect(bounded.snapshot.interactiveElements.length).toBeGreaterThan(0);
  });

  it("compacts a raw full-mode accessibility tree instead of shipping it", () => {
    const rawTree = {
      nodes: Array.from({ length: 4_000 }, (_, index) => ({
        nodeId: `node-${index}`,
        role: { value: "button" },
        name: { value: `label-${index}`.padEnd(240, "x") },
      })),
    };
    const bounded = boundPreviewAutomationSnapshot(snapshot({ accessibilityTree: rawTree }));

    expect(bounded.withinBudget).toBe(true);
    expect(bounded.snapshot.truncated).toContain("accessibilityTree");
    expect(bounded.snapshot.accessibilityTree).toMatchObject({ mode: "compact" });
    expect(measure(bounded.snapshot)).toBeLessThanOrEqual(
      PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
    );
  });

  it("drops an oversized screenshot rather than losing the whole snapshot", () => {
    const bounded = boundPreviewAutomationSnapshot(
      snapshot({
        screenshot: {
          mimeType: "image/png",
          data: Buffer.alloc(PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES + 1).toString("base64"),
          width: 1_280,
          height: 720,
        },
      }),
    );

    expect(bounded.withinBudget).toBe(true);
    expect(bounded.snapshot.screenshot).toBeNull();
    expect(bounded.snapshot.truncated).toContain("screenshot");
  });

  it("truncates an unbounded page url", () => {
    const bounded = boundPreviewAutomationSnapshot(
      snapshot({ url: `data:text/html,${"x".repeat(10_000)}` }),
    );

    expect(bounded.snapshot.url).toHaveLength(PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH);
    expect(bounded.snapshot.truncated).toContain("url");
  });
});
