import {
  type ModelCapabilities,
  type OpenCodeV2Settings,
  type ServerProviderModel,
} from "@shuv2code/contracts";
import { createModelCapabilities } from "@shuv2code/shared/model";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createOpenCodeV2Client } from "../opencodeV2Client.ts";
import { OpenCodeRuntime, openCodeRuntimeErrorDetail } from "../opencodeRuntime.ts";
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

interface V2Model {
  readonly id?: string;
  readonly providerID?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly status?: string;
  readonly variants?: ReadonlyArray<{ readonly id?: string }>;
}

interface V2Agent {
  readonly id?: string;
  readonly mode?: string;
  readonly hidden?: boolean;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function openCodeV2ModelsFromInventory(input: {
  readonly models: ReadonlyArray<unknown>;
  readonly agents: ReadonlyArray<unknown>;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const agents = input.agents as ReadonlyArray<V2Agent>;
  const primaryAgents = agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent =
    primaryAgents.find((agent) => agent.id === "build")?.id ?? primaryAgents[0]?.id;
  const liveModels = (input.models as ReadonlyArray<V2Model>).flatMap((model) => {
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
    return [
      {
        slug: `${providerID}/${id}`,
        name,
        subProvider: titleCaseSlug(providerID),
        isCustom: false,
        ...(model.status === "deprecated" ? { isLegacy: true } : {}),
        capabilities: createModelCapabilities({
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
        const [models, agents] = yield* Effect.tryPromise({
          try: () => Promise.all([client.model.list(), client.agent.list()]),
          catch: (cause) => new OpenCodeV2InventoryError({ cause }),
        }).pipe(Effect.orDie);
        return openCodeV2ModelsFromInventory({
          models: models.data,
          agents: agents.data,
          customModels: settings.customModels,
        });
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
    models: inventoryExit.value,
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      message: "opencode2 is ready.",
    },
  });
});
