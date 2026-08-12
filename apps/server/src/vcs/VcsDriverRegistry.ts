import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type {
  VcsDriverKind,
  VcsError,
  VcsRepositoryIdentity,
  VcsRepositorySelection,
  VcsSelectableKind,
  VcsSetProjectPreferenceInput,
  VcsSetProjectPreferenceResult,
} from "@shuv2code/contracts";
import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@shuv2code/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
const DETECTION_CACHE_TTL = Duration.seconds(2);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
  readonly selection?: VcsRepositorySelection;
}

type VcsDetectedDriverHandle = Required<Omit<VcsDriverHandle, "selection">>;

export interface VcsDriverInspection {
  readonly handle: VcsDriverHandle | null;
  readonly selection: VcsRepositorySelection;
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly inspect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverInspection, VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
    readonly setProjectPreference: (
      input: VcsSetProjectPreferenceInput,
    ) => Effect.Effect<VcsSetProjectPreferenceResult, VcsError>;
  }
>()("shuv2code/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsSelectableKind;
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsSelectableKind;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "git",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsSelectableKind,
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const git = yield* GitVcsDriver.makeVcsDriver;
  const jj = yield* JjVcsDriver.makeVcsDriver;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
    jj,
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDetectedDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsSelectableKind;
  }) {
    const driver = yield* get(input.requestedKind);
    return yield* detectWithDriver(input.requestedKind, driver, input.cwd);
  });

  const detectionCache = yield* Cache.makeWith<string, VcsDetectedDriverHandle | null, VcsError>(
    (key) => detectResolvedKind(parseDetectionCacheKey(key)),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) => (detected === null ? Duration.zero : DETECTION_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolveDefaultKind = Effect.fn("VcsDriverRegistry.resolveDefaultKind")(function* () {
    if (Option.isNone(serverSettings)) {
      return "git" as const;
    }
    return yield* serverSettings.value.getSettings.pipe(
      Effect.map((settings) => settings.defaultVcsKind),
      Effect.catch((error) =>
        Effect.logWarning("Could not read the user's default VCS; using Git.").pipe(
          Effect.annotateLogs({ error }),
          Effect.as("git" as const),
        ),
      ),
    );
  });

  const inspect: VcsDriverRegistry["Service"]["inspect"] = Effect.fn("VcsDriverRegistry.inspect")(
    function* (input) {
      const configuredKind = yield* projectConfig.resolveKind({ cwd: input.cwd });
      const defaultKind = yield* resolveDefaultKind();
      const requestedKind =
        input.requestedKind === "git" || input.requestedKind === "jj" ? input.requestedKind : null;
      const projectKind =
        configuredKind === "git" || configuredKind === "jj" ? configuredKind : null;
      if (requestedKind) {
        const resolvedHandle = yield* Cache.get(
          detectionCache,
          detectionCacheKey({ cwd: input.cwd, requestedKind }),
        );
        const selection = {
          availableKinds: resolvedHandle ? [requestedKind] : [],
          projectKind,
          defaultKind,
          source: "request",
        } satisfies VcsRepositorySelection;
        return {
          handle: resolvedHandle ? { ...resolvedHandle, selection } : null,
          selection,
        } satisfies VcsDriverInspection;
      }
      const preferredKind = requestedKind ?? projectKind ?? defaultKind;
      const [gitHandle, jjHandle] = yield* Effect.all(
        [
          Cache.get(detectionCache, detectionCacheKey({ cwd: input.cwd, requestedKind: "git" })),
          Cache.get(detectionCache, detectionCacheKey({ cwd: input.cwd, requestedKind: "jj" })),
        ],
        { concurrency: "unbounded" },
      );
      const handles = { git: gitHandle, jj: jjHandle } as const;
      const availableKinds = (["git", "jj"] as const).filter((kind) => handles[kind] !== null);
      const fallbackKind = preferredKind === "git" ? "jj" : "git";
      const resolvedHandle = handles[preferredKind] ?? handles[fallbackKind];
      const source = requestedKind
        ? "request"
        : projectKind
          ? resolvedHandle?.kind === projectKind
            ? "project"
            : "fallback"
          : resolvedHandle?.kind === defaultKind
            ? "user-default"
            : "fallback";
      const selection = {
        availableKinds,
        projectKind,
        defaultKind,
        source,
      } satisfies VcsRepositorySelection;

      return {
        handle: resolvedHandle ? { ...resolvedHandle, selection } : null,
        selection,
      } satisfies VcsDriverInspection;
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      return (yield* inspect(input)).handle;
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  const setProjectPreference: VcsDriverRegistry["Service"]["setProjectPreference"] = Effect.fn(
    "VcsDriverRegistry.setProjectPreference",
  )(function* (input) {
    yield* projectConfig.setKind(input).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "VcsDriverRegistry.setProjectPreference",
            cwd: input.cwd,
            detail: "Could not persist the project VCS preference.",
            cause,
          }),
      ),
    );
    yield* Cache.invalidateAll(detectionCache);
    const inspected = yield* inspect({ cwd: input.cwd });
    return {
      kind: inspected.handle?.kind ?? "unknown",
      selection: inspected.selection,
    } satisfies VcsSetProjectPreferenceResult;
  });

  return VcsDriverRegistry.of({
    get,
    inspect,
    detect,
    resolve,
    setProjectPreference,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
