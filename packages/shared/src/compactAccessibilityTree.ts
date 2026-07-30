import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const MAX_COMPACT_ACCESSIBILITY_NODES = 120;
const MAX_ACCESSIBILITY_TEXT_LENGTH = 240;
const MAX_CONTEXT_DEPTH = 6;
const MAX_ACCESSIBILITY_STATE_INPUTS = 64;

const RawAxValue = Schema.Struct({
  value: Schema.optional(Schema.Unknown),
});

const RawAxProperty = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(RawAxValue),
});

const RawAxNode = Schema.Struct({
  nodeId: Schema.String,
  backendDOMNodeId: Schema.optional(Schema.Int),
  parentId: Schema.optional(Schema.String),
  ignored: Schema.optional(Schema.Boolean),
  role: Schema.optional(RawAxValue),
  name: Schema.optional(RawAxValue),
  description: Schema.optional(RawAxValue),
  value: Schema.optional(RawAxValue),
  properties: Schema.optional(Schema.Array(RawAxProperty)),
});

const RawAxTree = Schema.Struct({
  nodes: Schema.Array(RawAxNode),
});

const decodeRawAxTree = Schema.decodeUnknownOption(RawAxTree);

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "document",
  "form",
  "heading",
  "main",
  "navigation",
  "region",
  "rootwebarea",
  "search",
  "status",
]);

const URGENT_ROLES = new Set(["alert", "alertdialog", "dialog", "status"]);
const VALUE_ROLES = new Set(["meter", "progressbar"]);

const STATE_NAMES = new Set([
  "autocomplete",
  "busy",
  "checked",
  "disabled",
  "editable",
  "expanded",
  "focusable",
  "focused",
  "hasPopup",
  "haspopup",
  "invalid",
  "level",
  "live",
  "modal",
  "multiselectable",
  "orientation",
  "pressed",
  "readonly",
  "required",
  "selected",
]);

type RawNode = typeof RawAxNode.Type;

export interface CompactAccessibilityState {
  readonly name: string;
  readonly value: string | number | boolean;
}

export interface CompactAccessibilityNode {
  readonly nodeId: string;
  readonly backendDOMNodeId?: number;
  readonly role: string;
  readonly name?: string;
  readonly description?: string;
  readonly value?: string;
  readonly context?: string;
  readonly states: ReadonlyArray<CompactAccessibilityState>;
}

export interface CompactAccessibilityTree {
  readonly mode: "compact";
  readonly totalNodeCount: number;
  readonly relevantNodeCount: number;
  readonly includedNodeCount: number;
  readonly truncated: boolean;
  readonly nodes: ReadonlyArray<CompactAccessibilityNode>;
  readonly unavailableReason?: string;
}

const CompactAccessibilityStateSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
});

const CompactAccessibilityNodeSchema = Schema.Struct({
  nodeId: Schema.String,
  backendDOMNodeId: Schema.optional(Schema.Int),
  role: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  states: Schema.Array(CompactAccessibilityStateSchema),
});

const CompactAccessibilityTreeSchema = Schema.Struct({
  mode: Schema.Literal("compact"),
  totalNodeCount: Schema.Number,
  relevantNodeCount: Schema.Number,
  includedNodeCount: Schema.Number,
  truncated: Schema.Boolean,
  nodes: Schema.Array(CompactAccessibilityNodeSchema),
  unavailableReason: Schema.optional(Schema.String),
});

const decodeCompactAccessibilityTree = Schema.decodeUnknownOption(CompactAccessibilityTreeSchema);

function scalarValue(value: unknown): string | number | boolean | undefined {
  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return value;
  }
  return undefined;
}

function compactText(value: unknown): string | undefined {
  const scalar = scalarValue(value);
  if (scalar === undefined) return undefined;
  const normalized = String(scalar).replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, MAX_ACCESSIBILITY_TEXT_LENGTH);
}

function canonicalizeStates(
  inputs: ReadonlyArray<{ readonly name: string; readonly value: unknown }>,
): ReadonlyArray<CompactAccessibilityState> {
  const states = new Map<string, CompactAccessibilityState["value"]>();
  for (const input of inputs.slice(0, MAX_ACCESSIBILITY_STATE_INPUTS)) {
    if (!STATE_NAMES.has(input.name)) continue;
    const name = input.name === "haspopup" ? "hasPopup" : input.name;
    const scalar = scalarValue(input.value);
    const value = Predicate.isString(scalar) ? compactText(scalar) : scalar;
    if (value === undefined) continue;
    states.set(name, value);
  }
  return [...states].map(([name, value]) => ({ name, value }));
}

function axValue(value: RawNode["role"]): unknown {
  return value?.value;
}

function compactStates(node: RawNode): ReadonlyArray<CompactAccessibilityState> {
  return canonicalizeStates(
    (node.properties ?? []).slice(0, MAX_ACCESSIBILITY_STATE_INPUTS).map((property) => ({
      name: property.name,
      value: property.value?.value,
    })),
  );
}

function boundedCount(value: number, minimum: number): number {
  return Number.isSafeInteger(value) && value >= minimum ? value : minimum;
}

function canonicalizeCompactNode(
  node: typeof CompactAccessibilityNodeSchema.Type,
): CompactAccessibilityNode | undefined {
  const nodeId = compactText(node.nodeId);
  const role = compactText(node.role)?.toLowerCase();
  if (nodeId === undefined || role === undefined) return undefined;
  const name = compactText(node.name);
  const description = compactText(node.description);
  const value = compactText(node.value);
  const context = compactText(node.context);
  return {
    nodeId,
    ...(node.backendDOMNodeId === undefined || !Number.isSafeInteger(node.backendDOMNodeId)
      ? {}
      : { backendDOMNodeId: node.backendDOMNodeId }),
    role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(value === undefined ? {} : { value }),
    ...(context === undefined ? {} : { context }),
    states: canonicalizeStates(node.states),
  };
}

function stateValue(
  states: ReadonlyArray<CompactAccessibilityState>,
  name: string,
): CompactAccessibilityState["value"] | undefined {
  return states.find((state) => state.name === name)?.value;
}

function hasMeaningfulState(states: ReadonlyArray<CompactAccessibilityState>): boolean {
  return states.some(({ name, value }) => {
    if (name === "focusable") return false;
    if (name === "live") return value !== "off";
    if (name === "invalid") return value !== false && value !== "false";
    return value === true || (name === "checked" && value === "mixed");
  });
}

function relevanceScore(
  role: string,
  name: string | undefined,
  description: string | undefined,
  value: string | undefined,
  states: ReadonlyArray<CompactAccessibilityState>,
): number {
  let score = 0;
  if (stateValue(states, "focused") === true) score += 1_000;
  if (URGENT_ROLES.has(role)) score += 500;
  if (ACTIONABLE_ROLES.has(role)) score += 300;
  if (STRUCTURAL_ROLES.has(role) && name !== undefined) score += 150;
  if (VALUE_ROLES.has(role) && (value !== undefined || description !== undefined)) score += 150;
  if (hasMeaningfulState(states)) score += 100;
  if (name !== undefined && stateValue(states, "focusable") === true) score += 75;
  if (score === 0) return 0;
  if (name !== undefined) score += 25;
  return score;
}

function nearestNamedContext(
  node: RawNode,
  nodesById: ReadonlyMap<string, RawNode>,
): string | undefined {
  let parentId = node.parentId;
  for (let depth = 0; depth < MAX_CONTEXT_DEPTH && parentId !== undefined; depth += 1) {
    const parent = nodesById.get(parentId);
    if (!parent) return undefined;
    const role = compactText(axValue(parent.role))?.toLowerCase();
    const name = compactText(axValue(parent.name));
    if (role && name && role !== "generic" && role !== "none") {
      return `${role} ${JSON.stringify(name)}`.slice(0, MAX_ACCESSIBILITY_TEXT_LENGTH);
    }
    parentId = parent.parentId;
  }
  return undefined;
}

export function compactAccessibilityTree(tree: unknown): CompactAccessibilityTree {
  const alreadyCompact = decodeCompactAccessibilityTree(tree);
  if (Option.isSome(alreadyCompact)) {
    const compact = alreadyCompact.value;
    const nodes = compact.nodes.slice(0, MAX_COMPACT_ACCESSIBILITY_NODES).flatMap((node) => {
      const canonical = canonicalizeCompactNode(node);
      return canonical === undefined ? [] : [canonical];
    });
    const relevantNodeCount = boundedCount(compact.relevantNodeCount, nodes.length);
    const totalNodeCount = boundedCount(compact.totalNodeCount, relevantNodeCount);
    const unavailableReason = compactText(compact.unavailableReason);
    return {
      mode: "compact",
      totalNodeCount,
      relevantNodeCount,
      includedNodeCount: nodes.length,
      truncated:
        compact.truncated ||
        compact.nodes.length > nodes.length ||
        relevantNodeCount > nodes.length,
      nodes,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    };
  }
  const decoded = decodeRawAxTree(tree);
  if (Option.isNone(decoded)) {
    return {
      mode: "compact",
      totalNodeCount: 0,
      relevantNodeCount: 0,
      includedNodeCount: 0,
      truncated: false,
      nodes: [],
      unavailableReason: "Chrome accessibility tree was unavailable or malformed.",
    };
  }

  const rawNodes = decoded.value.nodes;
  const nodesById = new Map(rawNodes.map((node) => [node.nodeId, node]));
  const relevant = rawNodes.flatMap((node, index) => {
    if (node.ignored === true) return [];
    const role = compactText(axValue(node.role))?.toLowerCase();
    if (!role) return [];
    const name = compactText(axValue(node.name));
    const description = compactText(axValue(node.description));
    const value = compactText(axValue(node.value));
    const states = compactStates(node);
    const score = relevanceScore(role, name, description, value, states);
    if (score === 0) return [];
    const context = nearestNamedContext(node, nodesById);
    return [
      {
        index,
        score,
        node: {
          nodeId: node.nodeId,
          ...(node.backendDOMNodeId === undefined
            ? {}
            : { backendDOMNodeId: node.backendDOMNodeId }),
          role,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(value === undefined ? {} : { value }),
          ...(context === undefined ? {} : { context }),
          states,
        } satisfies CompactAccessibilityNode,
      },
    ];
  });

  const selected = [...relevant]
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_COMPACT_ACCESSIBILITY_NODES)
    .sort((left, right) => left.index - right.index)
    .map(({ node }) => node);

  return {
    mode: "compact",
    totalNodeCount: rawNodes.length,
    relevantNodeCount: relevant.length,
    includedNodeCount: selected.length,
    truncated: relevant.length > selected.length,
    nodes: selected,
  };
}
