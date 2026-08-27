import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@shuv2code/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  isAgentCapableModel,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const codex = ProviderDriverKind.make("codex");

    expect(normalizeModelSlug("5.4", codex)).toBe("gpt-5.4");
    expect(normalizeCustomModelSlug(" 5.4 ")).toBe("5.4");
  });
});

describe("isAgentCapableModel", () => {
  const withCapabilities = (capabilities: ModelCapabilities | null): ServerProviderModel => ({
    slug: "kernel/model",
    name: "Kernel Model",
    isCustom: false,
    capabilities,
  });

  it("excludes only models that actively report they cannot do the job", () => {
    expect(
      isAgentCapableModel(
        withCapabilities(createModelCapabilities({ optionDescriptors: [], toolCalling: false })),
      ),
    ).toBe(false);
    expect(
      isAgentCapableModel(
        withCapabilities(
          createModelCapabilities({
            optionDescriptors: [],
            toolCalling: true,
            // An image model: it can call tools, it just cannot answer in text.
            textOutput: false,
          }),
        ),
      ),
    ).toBe(false);
  });

  it("treats unreported capabilities as capable", () => {
    // Only the shuvcode kernel reports this. Reading silence as a denial would
    // make every Codex, Cursor and hand-typed custom model unselectable.
    expect(isAgentCapableModel(withCapabilities(null))).toBe(true);
    expect(
      isAgentCapableModel(withCapabilities(createModelCapabilities({ optionDescriptors: [] }))),
    ).toBe(true);
  });

  it("keeps the reported flags on the capabilities it builds", () => {
    expect(
      createModelCapabilities({ optionDescriptors: [], toolCalling: true, textOutput: true }),
    ).toEqual({ optionDescriptors: [], toolCalling: true, textOutput: true });
    // Undefined stays absent rather than becoming an explicit `false`.
    expect(createModelCapabilities({ optionDescriptors: [] })).toEqual({ optionDescriptors: [] });
  });
});
