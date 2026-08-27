import { describe, expect, it } from "vite-plus/test";

import type {
  AdeBotModelSetting,
  BotExecutionBinding,
  BotId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@shuv2code/contracts";

import {
  ADE_MODEL_INSTANCE_ID,
  getBotModelLabel,
  hasLivePrimarySession,
  getBotModelOptions,
  getBotModelSavedMessage,
  isFlaggedBotModel,
  shouldSubmitBotModel,
} from "./botModel.logic";

const model = (slug: string, overrides: Partial<ServerProviderModel> = {}): ServerProviderModel =>
  ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [] },
    ...overrides,
  }) as ServerProviderModel;

const provider = (instanceId: string, models: ReadonlyArray<ServerProviderModel>): ServerProvider =>
  ({ instanceId: instanceId as ProviderInstanceId, models }) as ServerProvider;

describe("getBotModelOptions", () => {
  it("reads only the shuvcode instance", () => {
    const options = getBotModelOptions([
      provider("codex", [model("codex/gpt-5")]),
      provider(ADE_MODEL_INSTANCE_ID, [model("openai/gpt-5.6-sol")]),
    ]);
    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-5.6-sol"]);
  });

  it("keeps a model that cannot call tools, flagged and sorted last", () => {
    const options = getBotModelOptions([
      provider(ADE_MODEL_INSTANCE_ID, [
        model("opencode/big-pickle", {
          capabilities: { optionDescriptors: [], toolCalling: false },
        }),
        model("openai/chatgpt-image-latest", {
          capabilities: { optionDescriptors: [], textOutput: false },
        }),
        model("openai/gpt-5.6-sol", {
          capabilities: { optionDescriptors: [], toolCalling: true, textOutput: true },
        }),
      ]),
    ]);
    expect(options.map((option) => option.slug)).toEqual([
      "openai/gpt-5.6-sol",
      "opencode/big-pickle",
      "openai/chatgpt-image-latest",
    ]);
    expect(options.map((option) => option.agentCapable)).toEqual([true, false, false]);
  });

  it("treats unreported capabilities as capable", () => {
    const options = getBotModelOptions([
      provider(ADE_MODEL_INSTANCE_ID, [model("custom/thing", { capabilities: null })]),
    ]);
    expect(options[0]?.agentCapable).toBe(true);
  });

  it("carries the kernel's own configured default through", () => {
    const options = getBotModelOptions([
      provider(ADE_MODEL_INSTANCE_ID, [model("openai/a"), model("openai/b", { isDefault: true })]),
    ]);
    expect(options.find((option) => option.isKernelDefault)?.slug).toBe("openai/b");
  });

  it("is empty when the shuvcode instance is not configured", () => {
    expect(getBotModelOptions([provider("codex", [model("codex/gpt-5")])])).toEqual([]);
  });
});

describe("getBotModelLabel", () => {
  const options = getBotModelOptions([
    provider(ADE_MODEL_INSTANCE_ID, [model("openai/gpt-5.6-sol", { name: "GPT 5.6 Sol" })]),
  ]);

  it("names an unpinned bot's model as the kernel default rather than blank", () => {
    expect(getBotModelLabel(options, null)).toBe("Kernel default");
    expect(getBotModelLabel(options, undefined)).toBe("Kernel default");
  });

  it("prefers the display name and falls back to the raw slug", () => {
    expect(getBotModelLabel(options, "openai/gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(getBotModelLabel(options, "openai/retired")).toBe("openai/retired");
  });
});

describe("isFlaggedBotModel", () => {
  const options = getBotModelOptions([
    provider(ADE_MODEL_INSTANCE_ID, [
      model("opencode/big-pickle", { capabilities: { optionDescriptors: [], toolCalling: false } }),
      model("openai/gpt-5.6-sol"),
    ]),
  ]);

  it("flags only a model the kernel actively refused", () => {
    expect(isFlaggedBotModel(options, "opencode/big-pickle")).toBe(true);
    expect(isFlaggedBotModel(options, "openai/gpt-5.6-sol")).toBe(false);
  });

  it("does not flag a slug the catalog never mentioned", () => {
    expect(isFlaggedBotModel(options, "openai/retired")).toBe(false);
    expect(isFlaggedBotModel(options, null)).toBe(false);
  });
});

describe("shouldSubmitBotModel", () => {
  it("sends nothing when the pick is what the bot already runs", () => {
    expect(shouldSubmitBotModel("openai/a", "openai/a", false)).toBe(false);
  });

  it("sends a restart of the same model, because that is a real act", () => {
    expect(shouldSubmitBotModel("openai/a", "openai/a", true)).toBe(true);
  });

  it("sends the first pin a bot ever gets", () => {
    expect(shouldSubmitBotModel(null, "openai/a", false)).toBe(true);
  });

  it("refuses an empty pick", () => {
    expect(shouldSubmitBotModel("openai/a", null, true)).toBe(false);
    expect(shouldSubmitBotModel("openai/a", "", true)).toBe(false);
  });
});

describe("getBotModelSavedMessage", () => {
  const setting = (appliesToLiveSession: boolean): AdeBotModelSetting =>
    ({
      botId: "bot-1" as BotId,
      modelSelection: { instanceId: ADE_MODEL_INSTANCE_ID, model: "openai/gpt-5.6-sol" },
      appliesToLiveSession,
    }) as AdeBotModelSetting;

  it("never reports a dormant change as one that took effect", () => {
    expect(getBotModelSavedMessage(setting(false))).toContain(
      "until this conversation is restarted",
    );
    expect(getBotModelSavedMessage(setting(true))).toContain("from its next turn");
  });

  it("names the model either way", () => {
    expect(getBotModelSavedMessage(setting(false))).toContain("openai/gpt-5.6-sol");
    expect(getBotModelSavedMessage(setting(true))).toContain("openai/gpt-5.6-sol");
  });
});

describe("hasLivePrimarySession", () => {
  const binding = (purpose: string, status: string): BotExecutionBinding =>
    ({ purpose, status }) as BotExecutionBinding;

  it("sees the one binding that keeps the old model alive", () => {
    expect(hasLivePrimarySession([binding("primary-text", "active")])).toBe(true);
  });

  it("ignores a retired primary and a live non-primary", () => {
    expect(
      hasLivePrimarySession([binding("primary-text", "historical"), binding("voice", "active")]),
    ).toBe(false);
  });

  it("reports nothing live for a bot that has never chatted", () => {
    expect(hasLivePrimarySession([])).toBe(false);
  });
});
