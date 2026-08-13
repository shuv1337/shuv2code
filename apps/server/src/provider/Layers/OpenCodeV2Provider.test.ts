import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { openCodeV2ModelsFromInventory } from "./OpenCodeV2Provider.ts";

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
});
