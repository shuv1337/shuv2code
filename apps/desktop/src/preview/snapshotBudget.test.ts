import type { PreviewAutomationSnapshot } from "@shuv2code/contracts";
import {
  PREVIEW_AUTOMATION_ACCESSIBILITY_TREE_BUDGET_REASON,
  PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH,
  PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH,
  PREVIEW_AUTOMATION_MAX_SELECTOR_LENGTH,
  PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
  PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES,
} from "@shuv2code/contracts";
import { compactAccessibilityTree } from "@shuv2code/shared/compactAccessibilityTree";
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

const element = (
  index: number,
  selectorLength = PREVIEW_AUTOMATION_MAX_SELECTOR_LENGTH,
): PreviewAutomationSnapshot["interactiveElements"][number] => ({
  tag: "button",
  role: "button",
  name: "n".repeat(PREVIEW_AUTOMATION_MAX_ELEMENT_NAME_LENGTH),
  selector: `s${index}`.padEnd(selectorLength, "x"),
  x: 0,
  y: 0,
  width: 10,
  height: 10,
});

const elements = (count: number, selectorLength?: number) =>
  Array.from({ length: count }, (_, index) => element(index, selectorLength));

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

const expectOk = (result: ReturnType<typeof boundPreviewAutomationSnapshot>) => {
  if (!result.ok) throw new Error(`Expected an in-budget snapshot, got ${result.failure.budget}.`);
  return result.snapshot;
};

const compactTreeOfNodes = (count: number) =>
  compactAccessibilityTree({
    nodes: Array.from({ length: count }, (_, index) => ({
      nodeId: `node-${index}`,
      role: { value: "button" },
      name: { value: `label-${index}`.padEnd(240, "x") },
    })),
  });

describe("boundPreviewAutomationSnapshot", () => {
  it("leaves an in-budget snapshot untouched", () => {
    const bounded = expectOk(boundPreviewAutomationSnapshot(snapshot()));
    expect(bounded.truncated).toBeUndefined();
    expect(bounded).toEqual(snapshot());
  });

  it("keeps the producer worst case inside the budget MCP assembly enforces", () => {
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(
        snapshot({
          visibleText: "v".repeat(20_000),
          interactiveElements: elements(200),
          consoleEntries: Array.from({ length: 200 }, (_, index) => ({
            level: "log",
            text: `console-${index}`.padEnd(4_096, "x"),
            timestamp: "2026-07-30T00:00:00.000Z",
          })),
        }),
      ),
    );

    expect(measure(bounded)).toBeLessThanOrEqual(PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES);
    expect(bounded.truncated).toEqual(expect.arrayContaining(["consoleEntries"]));
    expect(bounded.interactiveElements.length).toBeGreaterThan(0);
  });

  it("drops the accessibility tree before sacrificing locators", () => {
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(
        snapshot({
          accessibilityTree: compactTreeOfNodes(120),
          interactiveElements: elements(200, 1_800),
        }),
      ),
    );

    expect(bounded.interactiveElements).toHaveLength(200);
    expect(bounded.truncated).toContain("accessibilityTree");
    expect(bounded.truncated).not.toContain("interactiveElements");
    expect(measure(bounded)).toBeLessThanOrEqual(PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES);
  });

  it("reports a dropped accessibility tree as a budget decision, not a Chrome fault", () => {
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(
        snapshot({
          accessibilityTree: compactTreeOfNodes(120),
          interactiveElements: elements(200, 1_800),
        }),
      ),
    );

    expect(bounded.accessibilityTree).toMatchObject({
      mode: "compact",
      nodes: [],
      truncated: true,
      unavailableReason: PREVIEW_AUTOMATION_ACCESSIBILITY_TREE_BUDGET_REASON,
    });
    expect(compactAccessibilityTree(bounded.accessibilityTree)).toEqual(bounded.accessibilityTree);
  });

  it("compacts a raw full-mode accessibility tree instead of shipping it", () => {
    const rawTree = {
      nodes: Array.from({ length: 4_000 }, (_, index) => ({
        nodeId: `node-${index}`,
        role: { value: "button" },
        name: { value: `label-${index}`.padEnd(240, "x") },
      })),
    };
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(snapshot({ accessibilityTree: rawTree })),
    );

    expect(bounded.truncated).toContain("accessibilityTree");
    expect(bounded.accessibilityTree).toMatchObject({ mode: "compact" });
    expect(measure(bounded)).toBeLessThanOrEqual(PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES);
  });

  it("trims page prose to the exact remaining allowance", () => {
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(
        snapshot({
          visibleText: "v".repeat(60_000),
          interactiveElements: elements(200, 1_800),
        }),
      ),
    );

    expect(bounded.truncated).toContain("visibleText");
    expect(bounded.visibleText.length).toBeLessThan(60_000);
    expect(bounded.interactiveElements).toHaveLength(200);
    expect(measure(bounded)).toBeLessThanOrEqual(PREVIEW_AUTOMATION_SNAPSHOT_METADATA_MAX_BYTES);
  });

  it("fails closed when a requested screenshot exceeds its budget", () => {
    const result = boundPreviewAutomationSnapshot(
      snapshot({
        screenshot: {
          mimeType: "image/png",
          data: Buffer.alloc(PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES + 1).toString("base64"),
          width: 1_280,
          height: 720,
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an out-of-budget screenshot failure.");
    expect(result.failure).toMatchObject({
      budget: "screenshot",
      maximumBytes: PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES,
    });
    expect(result.failure.actualBytes).toBeGreaterThan(PREVIEW_AUTOMATION_SNAPSHOT_IMAGE_MAX_BYTES);
  });

  it("truncates an unbounded page url", () => {
    const bounded = expectOk(
      boundPreviewAutomationSnapshot(snapshot({ url: `data:text/html,${"x".repeat(10_000)}` })),
    );

    expect(bounded.url).toHaveLength(PREVIEW_AUTOMATION_MAX_PAGE_URL_LENGTH);
    expect(bounded.truncated).toContain("url");
  });
});
