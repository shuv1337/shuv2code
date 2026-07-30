import { describe, expect, it } from "vite-plus/test";

import { compactAccessibilityTree } from "./CompactAccessibilityTree.ts";

const axValue = (value: unknown) => ({
  type: typeof value,
  value,
  sources: [{ type: "contents", value: { type: typeof value, value } }],
});

const axNode = (input: {
  readonly nodeId: string;
  readonly role: string;
  readonly name?: string;
  readonly parentId?: string;
  readonly ignored?: boolean;
  readonly properties?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
}) => ({
  nodeId: input.nodeId,
  role: axValue(input.role),
  ...(input.name === undefined ? {} : { name: axValue(input.name) }),
  ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
  ...(input.ignored === undefined ? {} : { ignored: input.ignored }),
  properties: (input.properties ?? []).map(({ name, value }) => ({
    name,
    value: axValue(value),
  })),
});

describe("compactAccessibilityTree", () => {
  it("keeps actionable, structural, focused, and live semantic nodes", () => {
    const result = compactAccessibilityTree({
      nodes: [
        axNode({ nodeId: "root", role: "RootWebArea", name: "Checkout" }),
        axNode({ nodeId: "decorative", role: "generic", parentId: "root" }),
        axNode({
          nodeId: "empty-focus-container",
          role: "generic",
          properties: [{ name: "focusable", value: true }],
        }),
        axNode({
          nodeId: "named-focus-fallback",
          role: "generic",
          name: "Custom picker",
          properties: [{ name: "focusable", value: true }],
        }),
        axNode({ nodeId: "copy", role: "StaticText", name: "Decorative copy" }),
        axNode({
          nodeId: "pay",
          role: "button",
          name: "Pay now",
          parentId: "root",
          properties: [
            { name: "focusable", value: true },
            { name: "focused", value: true },
            { name: "disabled", value: false },
            { name: "irrelevantInternalProperty", value: "drop me" },
          ],
        }),
        axNode({ nodeId: "email", role: "textbox", name: "Email", parentId: "root" }),
        axNode({ nodeId: "error", role: "alert", name: "Card was declined" }),
        axNode({ nodeId: "ignored", role: "button", name: "Hidden", ignored: true }),
      ],
    });

    expect(result).toMatchObject({
      mode: "compact",
      totalNodeCount: 9,
      relevantNodeCount: 5,
      includedNodeCount: 5,
      truncated: false,
    });
    expect(result.nodes.map(({ nodeId }) => nodeId)).toEqual([
      "root",
      "named-focus-fallback",
      "pay",
      "email",
      "error",
    ]);
    expect(result.nodes.find(({ nodeId }) => nodeId === "pay")).toEqual({
      nodeId: "pay",
      role: "button",
      name: "Pay now",
      context: 'rootwebarea "Checkout"',
      states: [
        { name: "focusable", value: true },
        { name: "focused", value: true },
        { name: "disabled", value: false },
      ],
    });
  });

  it("caps output while retaining a focused element late in document order", () => {
    const nodes = Array.from({ length: 140 }, (_, index) =>
      axNode({
        nodeId: `button-${index}`,
        role: "button",
        name: `Action ${index}`,
        properties: index === 139 ? [{ name: "focused", value: true }] : [],
      }),
    );

    const result = compactAccessibilityTree({ nodes });

    expect(result.includedNodeCount).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nodes.some(({ nodeId }) => nodeId === "button-139")).toBe(true);
  });

  it("removes verbose Chrome sources and decorative nodes from the model payload", () => {
    const verboseText = "raw accessibility implementation detail ".repeat(80);
    const nodes = [
      ...Array.from({ length: 400 }, (_, index) => ({
        ...axNode({
          nodeId: `copy-${index}`,
          role: "StaticText",
          name: `Copy ${index}`,
        }),
        name: axValue(`${verboseText}${index}`),
      })),
      ...Array.from({ length: 20 }, (_, index) =>
        axNode({ nodeId: `link-${index}`, role: "link", name: `Product ${index}` }),
      ),
    ];
    const raw = { nodes };

    const compact = compactAccessibilityTree(raw);
    const rawBytes = Buffer.byteLength(JSON.stringify(raw));
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));

    expect(compact.nodes).toHaveLength(20);
    expect(compactBytes).toBeLessThan(rawBytes * 0.05);
  });

  it("returns a bounded explanation when Chrome data is malformed", () => {
    expect(compactAccessibilityTree({ notNodes: [] })).toEqual({
      mode: "compact",
      totalNodeCount: 0,
      relevantNodeCount: 0,
      includedNodeCount: 0,
      truncated: false,
      nodes: [],
      unavailableReason: "Chrome accessibility tree was unavailable or malformed.",
    });
  });

  it("preserves a compact tree produced by the desktop host", () => {
    const compact = compactAccessibilityTree({
      nodes: [axNode({ nodeId: "submit", role: "button", name: "Submit" })],
    });

    expect(compactAccessibilityTree(compact)).toEqual(compact);
  });
});
