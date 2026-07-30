import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  readDesktopBaseVersion,
  resolveNightlyBaseVersion,
  resolveNightlyReleaseMetadata,
  resolveNightlyTargetVersion,
  writeNightlyReleaseOutput,
} from "./resolve-nightly-release.ts";

it("strips prerelease and build metadata when deriving the nightly base version", () => {
  assert.equal(resolveNightlyBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveNightlyBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveNightlyBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it.effect("keeps prerelease cores and bumps only stable committed versions", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveNightlyTargetVersion("0.0.17"), "0.0.18");
    assert.equal(yield* resolveNightlyTargetVersion("0.1.0"), "0.1.1");
    assert.equal(yield* resolveNightlyTargetVersion("0.1.0-alpha.1"), "0.1.0");
    assert.equal(yield* resolveNightlyTargetVersion("9.9.9-smoke.0"), "9.9.9");
    assert.equal(yield* resolveNightlyTargetVersion("1.2.3-beta.4+build.9"), "1.2.3");
  }),
);

it.effect("reports the invalid product package version", () =>
  Effect.gen(function* () {
    const error = yield* resolveNightlyTargetVersion("nightly").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidDesktopPackageVersionError");
    assert.equal(error.version, "nightly");
    assert.equal(error.message, "Invalid product package version 'nightly'.");
  }),
);

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "shuv2code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it.effect("preserves the GITHUB_OUTPUT configuration cause", () => {
  const metadata = resolveNightlyReleaseMetadata("1.2.4", "20260620", 42, "abcdef1234567890");
  const configCause = new ConfigProvider.SourceError({ message: "environment unavailable" });

  return Effect.gen(function* () {
    const configError = yield* writeNightlyReleaseOutput(metadata, true).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() => Effect.fail(configCause)),
      ),
      Effect.flip,
    );

    if (configError._tag !== "NightlyReleaseGitHubOutputConfigError") {
      return assert.fail(`Unexpected error: ${configError._tag}`);
    }
    assert.instanceOf(configError.cause, Config.ConfigError);
    assert.strictEqual(configError.cause.cause, configCause);
    assert.notInclude(configError.message, configCause.message);
  });
});

it.layer(NodeServices.layer)("readDesktopBaseVersion", (it) => {
  it.effect("preserves server package read context and its platform cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-read-",
      });
      const packageJsonPath = path.join(rootDir, "apps/server/package.json");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("preserves server package decode context and its schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-decode-",
      });
      const packageJsonPath = path.join(rootDir, "apps/server/package.json");
      yield* fs.makeDirectory(path.dirname(packageJsonPath), { recursive: true });
      yield* fs.writeFileString(packageJsonPath, "{");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "decode");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.ok(error.cause !== undefined);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("derives nightly core from the committed server version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-server-",
      });
      const packageJsonPath = path.join(rootDir, "apps/server/package.json");
      yield* fs.makeDirectory(path.dirname(packageJsonPath), { recursive: true });
      yield* fs.writeFileString(
        packageJsonPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Static JSON fixture content.
        `${JSON.stringify({ name: "shuv2code", version: "0.1.0-alpha.1" }, null, 2)}\n`,
      );

      assert.equal(yield* readDesktopBaseVersion(rootDir), "0.1.0");
    }),
  );
});
