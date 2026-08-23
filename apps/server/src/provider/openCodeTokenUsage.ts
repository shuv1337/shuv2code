import type { ThreadTokenUsageSnapshot } from "@shuv2code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const OpenCodeTokenCountersSchema = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
  cache: Schema.Struct({
    read: NonNegativeInt,
    write: NonNegativeInt,
  }),
});

const OpenCodeAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  providerID: Schema.String,
  modelID: Schema.String,
  tokens: OpenCodeTokenCountersSchema,
});

const OpenCodeV2ProjectedAssistantMessageSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  model: Schema.Struct({
    providerID: Schema.String,
    id: Schema.String,
  }),
  tokens: Schema.optionalKey(OpenCodeTokenCountersSchema),
});

const OpenCodeV2ProjectedMessagesSchema = Schema.Struct({
  data: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const OpenCodeModelSchema = Schema.Struct({
  id: Schema.String,
  providerID: Schema.optionalKey(Schema.String),
  limit: Schema.Struct({
    context: PositiveInt,
  }),
});

const OpenCodeV2ModelListSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});

const OpenCodeProviderListSchema = Schema.Struct({
  all: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      models: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});

const decodeAssistantMessage = Schema.decodeUnknownOption(OpenCodeAssistantMessageSchema);
const decodeProjectedAssistantMessage = Schema.decodeUnknownOption(
  OpenCodeV2ProjectedAssistantMessageSchema,
);
const decodeProjectedMessages = Schema.decodeUnknownOption(OpenCodeV2ProjectedMessagesSchema);
const decodeModel = Schema.decodeUnknownOption(OpenCodeModelSchema);
const decodeV2ModelList = Schema.decodeUnknownOption(OpenCodeV2ModelListSchema);
const decodeProviderList = Schema.decodeUnknownOption(OpenCodeProviderListSchema);

export interface OpenCodeAssistantUsage {
  readonly providerId: string;
  readonly modelId: string;
  readonly usage: ThreadTokenUsageSnapshot;
}

function toSnapshot(
  tokens: typeof OpenCodeTokenCountersSchema.Type,
  maxTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  // This matches OpenCode's own compaction accounting: uncached input,
  // cache reads, and generated output occupy the active context window.
  const usedTokens = tokens.input + tokens.cache.read + tokens.output;
  if (usedTokens <= 0) return undefined;

  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cache.read,
    outputTokens: tokens.output,
    reasoningOutputTokens: tokens.reasoning,
    lastUsedTokens: usedTokens,
    lastInputTokens: tokens.input,
    lastCachedInputTokens: tokens.cache.read,
    lastOutputTokens: tokens.output,
    lastReasoningOutputTokens: tokens.reasoning,
    compactsAutomatically: true,
  };
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function openCodeAssistantUsageFromMessage(
  value: unknown,
  modelContextLimits: ReadonlyMap<string, number>,
): OpenCodeAssistantUsage | undefined {
  const decoded = decodeAssistantMessage(value);
  if (Option.isNone(decoded)) return undefined;
  const message = decoded.value;
  const usage = toSnapshot(
    message.tokens,
    modelContextLimits.get(modelKey(message.providerID, message.modelID)),
  );
  return usage ? { providerId: message.providerID, modelId: message.modelID, usage } : undefined;
}

export function latestOpenCodeV2ProjectedAssistantUsage(
  value: unknown,
  modelContextLimits: ReadonlyMap<string, number>,
): OpenCodeAssistantUsage | undefined {
  const decoded = decodeProjectedMessages(value);
  if (Option.isNone(decoded)) return undefined;
  const messages = decoded.value.data ?? decoded.value.items ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = decodeProjectedAssistantMessage(messages[index]);
    if (Option.isNone(candidate)) continue;
    const message = candidate.value;
    if (message.tokens === undefined) continue;
    const tokens = message.tokens;
    const usage = toSnapshot(
      tokens,
      modelContextLimits.get(modelKey(message.model.providerID, message.model.id)),
    );
    if (usage) {
      return {
        providerId: message.model.providerID,
        modelId: message.model.id,
        usage,
      };
    }
  }
  return undefined;
}

export function openCodeV2ModelContextLimits(value: unknown): ReadonlyMap<string, number> {
  const decoded = decodeV2ModelList(value);
  if (Option.isNone(decoded)) return new Map();
  const limits = new Map<string, number>();
  for (const value of decoded.value.data) {
    const model = decodeModel(value);
    if (Option.isSome(model) && model.value.providerID) {
      limits.set(modelKey(model.value.providerID, model.value.id), model.value.limit.context);
    }
  }
  return limits;
}

export function openCodeProviderModelContextLimits(value: unknown): ReadonlyMap<string, number> {
  const decoded = decodeProviderList(value);
  if (Option.isNone(decoded)) return new Map();
  const limits = new Map<string, number>();
  for (const provider of decoded.value.all) {
    for (const [modelId, value] of Object.entries(provider.models)) {
      const model = decodeModel(value);
      if (Option.isSome(model)) {
        limits.set(modelKey(provider.id, modelId), model.value.limit.context);
      }
    }
  }
  return limits;
}
