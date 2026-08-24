import { describe, expect, it } from "@effect/vitest";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerSettings,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { applyOpenCodeV2Binding } from "./OpenCodeV2Binding.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const OPENCODE_V2 = ProviderDriverKind.make("opencodeV2");

describe("applyOpenCodeV2Binding", () => {
  it.effect("rewrites persisted identity after a conclusive v2 probe", () =>
    Effect.gen(function* () {
      const patches: Array<unknown> = [];
      const remaps: Array<string> = [];
      const settings = {
        providers: {},
        providerInstances: {
          opencode: {
            driver: "opencode",
            enabled: true,
            config: {
              enabled: true,
              binaryPath: "opencode",
              serverUrl: "",
              serverPassword: "",
              customModels: [],
            },
          },
        },
      } as unknown as ServerSettings;

      const runtime = {
        runOpenCodeCommand: () =>
          Effect.succeed({
            stdout: "shuvcode v0.0.0-integration-v2-202608121817\n",
            stderr: "",
            exitCode: 0,
          }),
      } as unknown as OpenCodeRuntimeShape;

      yield* applyOpenCodeV2Binding(settings).pipe(
        Effect.provideService(OpenCodeRuntime, runtime),
        Effect.provideService(FileSystem.FileSystem, {
          exists: () => Effect.succeed(true),
        } as unknown as FileSystem.FileSystem),
        Effect.provideService(ServerSettingsService, {
          updateSettings: (patch: unknown) => {
            patches.push(patch);
            return Effect.succeed(settings);
          },
        } as unknown as ServerSettingsService["Service"]),
        Effect.provideService(ProviderSessionRuntimeRepository, {
          remapOpenCodeV2Identity: () => {
            remaps.push("runtime");
            return Effect.void;
          },
        } as unknown as ProviderSessionRuntimeRepository["Service"]),
        Effect.provideService(ProjectionThreadSessionRepository, {
          remapOpenCodeV2Identity: () => {
            remaps.push("session");
            return Effect.void;
          },
        } as unknown as ProjectionThreadSessionRepository["Service"]),
        Effect.provideService(ProjectionThreadRepository, {
          remapOpenCodeV2ModelSelection: () => {
            remaps.push("thread");
            return Effect.void;
          },
        } as unknown as ProjectionThreadRepository["Service"]),
      );

      expect(patches).toHaveLength(1);
      expect(remaps).toEqual(["runtime", "session", "thread"]);
      const patch = patches[0] as {
        providerInstances: Record<string, { driver: string }>;
      };
      expect(patch.providerInstances[defaultInstanceIdForDriver(OPENCODE_V2)]?.driver).toBe(
        OPENCODE_V2,
      );
      expect(defaultInstanceIdForDriver(OPENCODE)).toBe(defaultInstanceIdForDriver(OPENCODE));
    }),
  );

  it.effect("leaves a v1 binary unchanged", () =>
    Effect.gen(function* () {
      let updated = false;
      const settings = {
        providers: {},
        providerInstances: {
          opencode: {
            driver: "opencode",
            enabled: true,
            config: {
              enabled: true,
              binaryPath: "opencode",
              serverUrl: "",
              serverPassword: "",
              customModels: [],
            },
          },
        },
      } as unknown as ServerSettings;
      const runtime = {
        runOpenCodeCommand: () =>
          Effect.succeed({
            stdout: "opencode 1.14.19\n",
            stderr: "",
            exitCode: 0,
          }),
      } as unknown as OpenCodeRuntimeShape;

      yield* applyOpenCodeV2Binding(settings).pipe(
        Effect.provideService(OpenCodeRuntime, runtime),
        Effect.provideService(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
        } as unknown as FileSystem.FileSystem),
        Effect.provideService(ServerSettingsService, {
          updateSettings: () => {
            updated = true;
            return Effect.succeed(settings);
          },
        } as unknown as ServerSettingsService["Service"]),
        Effect.provideService(ProviderSessionRuntimeRepository, {
          remapOpenCodeV2Identity: () => Effect.void,
        } as unknown as ProviderSessionRuntimeRepository["Service"]),
        Effect.provideService(ProjectionThreadSessionRepository, {
          remapOpenCodeV2Identity: () => Effect.void,
        } as unknown as ProjectionThreadSessionRepository["Service"]),
        Effect.provideService(ProjectionThreadRepository, {
          remapOpenCodeV2ModelSelection: () => Effect.void,
        } as unknown as ProjectionThreadRepository["Service"]),
      );

      expect(updated).toBe(false);
    }),
  );
});
