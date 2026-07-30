import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ProviderInstanceId } from "@shuv2code/contracts";

import { normalizeAutomationCreateInput } from "./handlers.ts";

const context = {
  projectId: ProjectId.make("project-1"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

describe("normalizeAutomationCreateInput", () => {
  it("defaults to paused, skips overlap, and inherits the current chat runtime", () => {
    expect(
      normalizeAutomationCreateInput(
        {
          name: "Daily report",
          prompt: "Create the report.",
          cronExpression: "0 9 * * *",
          timeZone: "Europe/London",
        },
        context,
      ),
    ).toEqual({
      projectId: context.projectId,
      name: "Daily report",
      prompt: "Create the report.",
      enabled: false,
      cronExpression: "0 9 * * *",
      timeZone: "Europe/London",
      modelSelection: context.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      concurrencyPolicy: "skip",
    });
  });

  it("preserves explicit activation, provider, runtime, interaction, and overlap choices", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "open-model",
    };
    expect(
      normalizeAutomationCreateInput(
        {
          name: "Parallel report",
          prompt: "Create the report in parallel.",
          enabled: true,
          cronExpression: "*/15 * * * *",
          timeZone: "UTC",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          concurrencyPolicy: "parallel",
        },
        context,
      ),
    ).toMatchObject({
      enabled: true,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      concurrencyPolicy: "parallel",
    });
  });
});
