import {
  type ModelCapabilities,
  type OpenCodeV2Settings,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@shuv2code/contracts";
import { createModelCapabilities } from "@shuv2code/shared/model";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createOpenCodeV2Client } from "../opencodeV2Client.ts";
import { OpenCodeRuntime, openCodeRuntimeErrorDetail } from "../opencodeRuntime.ts";
import { titleCaseSlug } from "../opencodeShared.ts";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const OPENCODE_V2_PRESENTATION = {
  displayName: "opencode2",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

class OpenCodeV2InventoryError extends Data.TaggedError("OpenCodeV2InventoryError")<{
  readonly cause: unknown;
}> {}

const V2VariantSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
});
const V2ModelCapabilitiesSchema = Schema.Struct({
  tools: Schema.optionalKey(Schema.Boolean),
  output: Schema.optionalKey(Schema.Array(Schema.String)),
});
const V2ModelSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  providerID: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  variants: Schema.optionalKey(Schema.Array(V2VariantSchema)),
  capabilities: Schema.optionalKey(V2ModelCapabilitiesSchema),
});
const V2AgentSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  hidden: Schema.optionalKey(Schema.Boolean),
});
const V2SkillSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  location: Schema.String,
});
const decodeV2Model = Schema.decodeUnknownOption(V2ModelSchema);
const decodeV2Agent = Schema.decodeUnknownOption(V2AgentSchema);
const decodeV2Skill = Schema.decodeUnknownOption(V2SkillSchema);

export function openCodeV2SkillsFromInventory(
  input: ReadonlyArray<unknown>,
): ReadonlyArray<ServerProviderSkill> {
  return input.flatMap((entry) => {
    const decoded = decodeV2Skill(entry);
    if (Option.isNone(decoded)) return [];
    const skill = decoded.value;
    const name = nonEmptyTrimmed(skill.id);
    const path = nonEmptyTrimmed(skill.location);
    if (!name || !path) return [];
    const displayName = nonEmptyTrimmed(skill.name);
    const description = nonEmptyTrimmed(skill.description);
    return [
      {
        name,
        path,
        enabled: true,
        ...(displayName && displayName !== name ? { displayName } : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
}

/**
 * The kernel's `/api/model/default` payload, reduced to the slug it names.
 * Anything else (an older build's 404, a shape we do not recognize) is simply
 * "no kernel default" — never a hard failure.
 */
export function openCodeV2DefaultModelSlug(input: unknown): string | undefined {
  const decoded = decodeV2Model(input);
  if (Option.isNone(decoded)) return undefined;
  const id = nonEmptyTrimmed(decoded.value.id);
  const providerID = nonEmptyTrimmed(decoded.value.providerID);
  return id && providerID ? `${providerID}/${id}` : undefined;
}

export function openCodeV2ModelsFromInventory(input: {
  readonly models: ReadonlyArray<unknown>;
  readonly agents: ReadonlyArray<unknown>;
  readonly customModels: ReadonlyArray<string>;
  /** Slug the kernel reports for `model:`, when it answered. */
  readonly defaultSlug?: string | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const agents = input.agents.flatMap((agent) => {
    const decoded = decodeV2Agent(agent);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const primaryAgents = agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent =
    primaryAgents.find((agent) => agent.id === "build")?.id ?? primaryAgents[0]?.id;
  const liveModels = input.models.flatMap((entry) => {
    const decoded = decodeV2Model(entry);
    if (Option.isNone(decoded)) return [];
    const model = decoded.value;
    const id = nonEmptyTrimmed(model.id);
    const providerID = nonEmptyTrimmed(model.providerID);
    const name = nonEmptyTrimmed(model.name);
    if (!id || !providerID || !name || model.enabled === false) return [];
    const variants = (model.variants ?? []).flatMap((variant) => {
      const value = nonEmptyTrimmed(variant.id);
      return value ? [{ id: value, label: titleCaseSlug(value) }] : [];
    });
    const agentOptions = primaryAgents.flatMap((agent) => {
      const value = nonEmptyTrimmed(agent.id);
      return value
        ? [
            {
              id: value,
              label: titleCaseSlug(value),
              ...(value === defaultAgent ? { isDefault: true as const } : {}),
            },
          ]
        : [];
    });
    const slug = `${providerID}/${id}`;
    const output = model.capabilities?.output;
    return [
      {
        slug,
        name,
        subProvider: titleCaseSlug(providerID),
        isCustom: false,
        ...(model.status === "deprecated" ? { isLegacy: true } : {}),
        ...(input.defaultSlug !== undefined && input.defaultSlug === slug
          ? { isDefault: true as const }
          : {}),
        capabilities: createModelCapabilities({
          ...(model.capabilities?.tools === undefined
            ? {}
            : { toolCalling: model.capabilities.tools }),
          ...(output === undefined
            ? {}
            : { textOutput: output.some((modality) => modality.startsWith("text")) }),
          optionDescriptors: [
            ...(variants.length > 0
              ? [{ id: "variant", label: "Variant", type: "select" as const, options: variants }]
              : []),
            ...(agentOptions.length > 0
              ? [
                  {
                    id: "agent",
                    label: "Agent",
                    type: "select" as const,
                    options: agentOptions,
                    ...(defaultAgent ? { currentValue: defaultAgent } : {}),
                  },
                ]
              : []),
          ],
        }),
      } satisfies ServerProviderModel,
    ];
  });
  return providerModelsFromSettings(liveModels, input.customModels, DEFAULT_CAPABILITIES).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  );
}

export const makePendingOpenCodeV2Provider = Effect.fn("makePendingOpenCodeV2Provider")(function* (
  settings: OpenCodeV2Settings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: OPENCODE_V2_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "opencode2 provider status has not been checked in this session yet.",
    },
  });
});

export const checkOpenCodeV2ProviderStatus = Effect.fn("checkOpenCodeV2ProviderStatus")(function* (
  settings: OpenCodeV2Settings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const runtime = yield* OpenCodeRuntime;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_V2_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "opencode2 is disabled in shuv2code settings.",
      },
    });
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* runtime.connectToOpenCodeServer({
          binaryPath: settings.binaryPath,
          requiredProtocol: "v2",
          serverUrl: settings.serverUrl,
          ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
          ...(environment ? { environment } : {}),
        });
        const client = createOpenCodeV2Client({
          baseUrl: server.url,
          directory: cwd,
          ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
        });
        const [[models, agents], skills, defaultSlug] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => Promise.all([client.model.list(), client.agent.list()]),
              catch: (cause) => new OpenCodeV2InventoryError({ cause }),
            }).pipe(Effect.orDie),
            Effect.tryPromise(() => client.skill.list()).pipe(
              Effect.timeout("2 seconds"),
              Effect.map((response) => openCodeV2SkillsFromInventory(response.data)),
              Effect.orElseSucceed((): ReadonlyArray<ServerProviderSkill> => []),
            ),
            // Optional by construction: a kernel build without the route just
            // has no configured default, which is a fallback, not an outage.
            Effect.tryPromise(() => client.model.default()).pipe(
              Effect.timeout("2 seconds"),
              Effect.map((response) => openCodeV2DefaultModelSlug(response.data)),
              Effect.orElseSucceed((): string | undefined => undefined),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return {
          models: openCodeV2ModelsFromInventory({
            models: models.data,
            agents: agents.data,
            customModels: settings.customModels,
            defaultSlug,
          }),
          skills,
        };
      }),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return buildServerProvider({
      presentation: OPENCODE_V2_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings([], settings.customModels, DEFAULT_CAPABILITIES),
      probe: {
        installed: settings.serverUrl.trim().length > 0,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: openCodeRuntimeErrorDetail(Cause.squash(inventoryExit.cause)),
      },
    });
  }
  return buildServerProvider({
    presentation: OPENCODE_V2_PRESENTATION,
    enabled: true,
    checkedAt,
    models: inventoryExit.value.models,
    skills: inventoryExit.value.skills,
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      message: "opencode2 is ready.",
    },
  });
});
