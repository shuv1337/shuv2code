import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  openCodeV2ModelsFromInventory,
  openCodeV2SkillsFromInventory,
} from "./OpenCodeV2Provider.ts";

describe("openCodeV2ModelsFromInventory", () => {
  it("maps native v2 models, variants, agents, and custom models", () => {
    const models = openCodeV2ModelsFromInventory({
      models: [
        {
          id: "gpt-5.4",
          providerID: "openai",
          name: "GPT-5.4",
          enabled: true,
          status: "active",
          variants: [{ id: "medium" }, { id: "high" }],
        },
        {
          id: "disabled",
          providerID: "openai",
          name: "Disabled",
          enabled: false,
        },
      ],
      agents: [
        { id: "build", mode: "primary", hidden: false },
        { id: "explore", mode: "subagent", hidden: false },
      ],
      customModels: ["custom/local"],
    });

    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["custom/local", "openai/gpt-5.4"],
    );
    const live = models.find((model) => model.slug === "openai/gpt-5.4");
    NodeAssert.deepEqual(
      live?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
      ["variant", "agent"],
    );
  });

  it("drops malformed model and agent inventory entries", () => {
    const models = openCodeV2ModelsFromInventory({
      models: [
        null,
        { id: 42, providerID: "openai", name: "Wrong id type" },
        { id: "bad-variants", providerID: "openai", name: "Bad variants", variants: [null] },
        { id: "valid", providerID: "openai", name: "Valid" },
      ],
      agents: [null, { id: 42, mode: "primary" }, { id: "build", mode: "primary", hidden: false }],
      customModels: [],
    });

    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["openai/valid"],
    );
    const agentDescriptor = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "agent",
    );
    NodeAssert.equal(agentDescriptor?.type, "select");
    if (agentDescriptor?.type !== "select") return;
    NodeAssert.deepEqual(
      agentDescriptor?.options?.map((option) => option.id),
      ["build"],
    );
  });
});

describe("openCodeV2SkillsFromInventory", () => {
  it("maps native skill IDs for invocation and preserves display metadata", () => {
    const skills = openCodeV2SkillsFromInventory([
      {
        id: "visual-explainer",
        name: "Visual Explainer",
        description: "Generate technical diagrams",
        location: "/home/test/.agents/skills/visual-explainer/SKILL.md",
      },
      { id: " malformed ", name: 42, location: null },
    ]);

    NodeAssert.deepEqual(skills, [
      {
        name: "visual-explainer",
        displayName: "Visual Explainer",
        description: "Generate technical diagrams",
        path: "/home/test/.agents/skills/visual-explainer/SKILL.md",
        enabled: true,
      },
    ]);
  });
});
