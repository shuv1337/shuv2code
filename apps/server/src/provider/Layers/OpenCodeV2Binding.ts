import {
  defaultInstanceIdForDriver,
  type OpenCodeSettings,
  type OpenCodeV2Settings,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  type ServerSettings,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  detectOpenCodeProtocolFromVersionOutput,
  OpenCodeRuntime,
  type OpenCodeProtocol,
} from "../opencodeRuntime.ts";
import {
  detectOpenCodeServerProtocol,
  resolveOpenCodeV2ServiceRegistrationPath,
} from "../opencodeV2Service.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const OPENCODE_V2_DRIVER = ProviderDriverKind.make("opencodeV2");
const OPENCODE_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_DRIVER);
const OPENCODE_V2_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_V2_DRIVER);

export const OPENCODE_V2_UNAVAILABLE_REASON =
  "this binary/server speaks OpenCode v2; use the opencode2 provider.";

export class OpenCodeV2BindingReady extends Context.Service<OpenCodeV2BindingReady, void>()(
  "shuv2code/provider/Layers/OpenCodeV2Binding/OpenCodeV2BindingReady",
) {}

function asOpenCodeSettings(config: unknown): OpenCodeSettings {
  const record = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  return {
    enabled: record.enabled !== false,
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : "",
    serverUrl: typeof record.serverUrl === "string" ? record.serverUrl : "",
    serverPassword: typeof record.serverPassword === "string" ? record.serverPassword : "",
    customModels: Array.isArray(record.customModels)
      ? record.customModels.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export const probeOpenCodeLegacyProtocol = Effect.fn("probeOpenCodeLegacyProtocol")(
  function* (input: {
    readonly settings: OpenCodeSettings;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<OpenCodeProtocol | null, never, OpenCodeRuntime | FileSystem.FileSystem> {
    const runtime = yield* OpenCodeRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverUrl = input.settings.serverUrl.trim();
    if (serverUrl.length > 0) {
      return yield* Effect.tryPromise({
        try: () =>
          detectOpenCodeServerProtocol({
            baseUrl: serverUrl,
            ...(input.settings.serverPassword
              ? { serverPassword: input.settings.serverPassword }
              : {}),
          }),
        catch: () => "protocol-detect-failed" as const,
      }).pipe(Effect.orElseSucceed(() => null));
    }

    const versionExit = yield* Effect.exit(
      runtime.runOpenCodeCommand({
        binaryPath: input.settings.binaryPath || "opencode",
        args: ["--version"],
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      }),
    );
    if (versionExit._tag === "Failure") {
      return null;
    }
    const protocol = detectOpenCodeProtocolFromVersionOutput(versionExit.value.stdout);
    if (protocol !== "v2") {
      return protocol;
    }
    const version =
      versionExit.value.stdout.match(/\b(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ??
      undefined;
    const registrationPath = resolveOpenCodeV2ServiceRegistrationPath({
      ...(version ? { version } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });
    const exists = yield* fileSystem
      .exists(registrationPath)
      .pipe(Effect.orElseSucceed(() => false));
    return exists ? "v2" : null;
  },
);

export const applyOpenCodeV2Binding = Effect.fn("applyOpenCodeV2Binding")(function* (
  settings: ServerSettings,
) {
  const settingsService = yield* ServerSettingsService;
  const runtimeRepository = yield* ProviderSessionRuntimeRepository;
  const sessionRepository = yield* ProjectionThreadSessionRepository;
  const threadRepository = yield* ProjectionThreadRepository;
  const legacyEnvelope = settings.providerInstances[OPENCODE_INSTANCE_ID];
  if (
    settings.providerInstances[OPENCODE_V2_INSTANCE_ID] !== undefined &&
    settings.providers.opencodeV2 !== undefined
  ) {
    return;
  }
  const legacyConfig = asOpenCodeSettings(legacyEnvelope?.config ?? settings.providers.opencode);
  const environment = mergeProviderInstanceEnvironment(legacyEnvelope?.environment);
  const protocol = yield* probeOpenCodeLegacyProtocol({
    settings: legacyConfig,
    environment,
  });
  if (protocol !== "v2") {
    return;
  }

  const v2Config = {
    enabled: true,
    binaryPath: legacyConfig.binaryPath,
    serverUrl: legacyConfig.serverUrl,
    serverPassword: legacyConfig.serverPassword,
    customModels: legacyConfig.customModels,
  } satisfies OpenCodeV2Settings;
  const nextV2: ProviderInstanceConfig = {
    driver: OPENCODE_V2_DRIVER,
    config: v2Config,
    ...(legacyEnvelope?.environment ? { environment: legacyEnvelope.environment } : {}),
    ...(legacyEnvelope?.displayName ? { displayName: legacyEnvelope.displayName } : {}),
    ...(legacyEnvelope?.accentColor ? { accentColor: legacyEnvelope.accentColor } : {}),
    enabled: legacyEnvelope?.enabled ?? true,
  };
  const nextInstances = {
    ...settings.providerInstances,
    [OPENCODE_V2_INSTANCE_ID]: settings.providerInstances[OPENCODE_V2_INSTANCE_ID] ?? nextV2,
  };

  yield* runtimeRepository.remapOpenCodeV2Identity({
    fromInstanceId: OPENCODE_INSTANCE_ID,
    toInstanceId: OPENCODE_V2_INSTANCE_ID,
    toProviderName: OPENCODE_V2_DRIVER,
  });
  yield* sessionRepository.remapOpenCodeV2Identity({
    fromInstanceId: OPENCODE_INSTANCE_ID,
    toInstanceId: OPENCODE_V2_INSTANCE_ID,
    toProviderName: OPENCODE_V2_DRIVER,
  });
  yield* threadRepository.remapOpenCodeV2ModelSelection({
    fromInstanceId: String(OPENCODE_INSTANCE_ID),
    toInstanceId: String(OPENCODE_V2_INSTANCE_ID),
  });
  yield* settingsService.updateSettings({
    providers: {
      opencodeV2: v2Config,
    },
    providerInstances: nextInstances,
  });
});

export const OpenCodeV2BindingLive = Layer.effect(
  OpenCodeV2BindingReady,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const changes = yield* settingsService.subscribeChanges;
    const initial = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    if (initial) {
      yield* applyOpenCodeV2Binding(initial);
    }
    yield* changes.pipe(
      Stream.runForEach((settings) =>
        applyOpenCodeV2Binding(settings).pipe(
          Effect.catchCause((cause) => Effect.logWarning("OpenCode v2 rebinding failed", cause)),
        ),
      ),
      Effect.forkScoped,
    );
    return undefined;
  }),
);
