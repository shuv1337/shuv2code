import * as NodeAssert from "node:assert/strict";
import { describe, it } from "@effect/vitest";

import {
  latestOpenCodeV2ProjectedAssistantUsage,
  openCodeAssistantUsageFromMessage,
  openCodeProviderModelContextLimits,
  openCodeV2ModelContextLimits,
} from "./openCodeTokenUsage.ts";

const tokens = {
  input: 1_000,
  output: 250,
  reasoning: 125,
  cache: { read: 4_000, write: 500 },
};

describe("OpenCode token usage", () => {
  it("normalizes legacy assistant usage against the advertised model limit", () => {
    const limits = openCodeProviderModelContextLimits({
      all: [
        {
          id: "openai",
          models: {
            "gpt-5.6-sol": {
              id: "gpt-5.6-sol",
              limit: { context: 258_400 },
            },
          },
        },
      ],
    });

    const result = openCodeAssistantUsageFromMessage(
      {
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        tokens,
      },
      limits,
    );

    NodeAssert.deepEqual(result?.usage, {
      usedTokens: 5_250,
      maxTokens: 258_400,
      inputTokens: 1_000,
      cachedInputTokens: 4_000,
      outputTokens: 250,
      reasoningOutputTokens: 125,
      lastUsedTokens: 5_250,
      lastInputTokens: 1_000,
      lastCachedInputTokens: 4_000,
      lastOutputTokens: 250,
      lastReasoningOutputTokens: 125,
      compactsAutomatically: true,
    });
  });

  it("uses the latest projected v2 assistant message instead of session totals", () => {
    const limits = openCodeV2ModelContextLimits({
      data: [
        {
          id: "gpt-5.6-sol",
          providerID: "openai",
          limit: { context: 258_400 },
        },
      ],
    });

    const result = latestOpenCodeV2ProjectedAssistantUsage(
      {
        data: [
          {
            type: "assistant",
            model: { providerID: "openai", id: "gpt-5.6-sol" },
            tokens: { ...tokens, input: 99_999 },
          },
          { type: "user", text: "follow up" },
          {
            type: "assistant",
            model: { providerID: "openai", id: "gpt-5.6-sol" },
            tokens,
          },
        ],
      },
      limits,
    );

    NodeAssert.equal(result?.usage.usedTokens, 5_250);
    NodeAssert.equal(result?.usage.maxTokens, 258_400);
  });

  it("rejects malformed and zero-token provider payloads", () => {
    NodeAssert.equal(
      openCodeAssistantUsageFromMessage({ role: "assistant" }, new Map()),
      undefined,
    );
    NodeAssert.equal(
      openCodeAssistantUsageFromMessage(
        {
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5.6-sol",
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        new Map(),
      ),
      undefined,
    );
  });
});
