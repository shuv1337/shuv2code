import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ReleaseRequestValidationError,
  validateReleaseRequest,
  writeReleaseRequestOutput,
} from "./validate-release-request.ts";

it.effect("accepts matching SemVer channels", () =>
  Effect.gen(function* () {
    assert.equal((yield* validateReleaseRequest("0.1.0", "latest")).npmDistTag, "latest");
    assert.equal((yield* validateReleaseRequest("0.1.0-alpha.2", "next")).npmDistTag, "next");
    assert.equal(
      (yield* validateReleaseRequest("0.1.0-nightly.20260730.1", "nightly")).npmDistTag,
      "nightly",
    );
  }),
);

it.effect("rejects channel mismatches and invalid versions", () =>
  Effect.gen(function* () {
    const mismatch = yield* validateReleaseRequest("0.1.0-alpha.2", "latest").pipe(Effect.flip);
    assert.instanceOf(mismatch, ReleaseRequestValidationError);
    assert.equal(
      mismatch.message,
      "Release version '0.1.0-alpha.2' maps to npm dist-tag 'next', not 'latest'.",
    );

    const invalid = yield* validateReleaseRequest("not-a-version").pipe(Effect.flip);
    assert.instanceOf(invalid, ReleaseRequestValidationError);
    assert.equal(invalid.message, "Invalid release version 'not-a-version'.");
  }),
);

it.layer(NodeServices.layer)("writeReleaseRequestOutput", (it) => {
  it.effect("writes github outputs for a valid release request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "validate-release-request-",
      });
      const githubOutputPath = path.join(baseDir, "github-output.txt");

      yield* writeReleaseRequestOutput("0.1.0-alpha.2", "next", true).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_OUTPUT: githubOutputPath,
              },
            }),
          ),
        ),
      );

      assert.equal(
        yield* fs.readFileString(githubOutputPath),
        [
          "version=0.1.0-alpha.2",
          "npm_dist_tag=next",
          "github_prerelease=true",
          "github_make_latest=false",
          "release_class=prerelease",
          "",
        ].join("\n"),
      );
    }),
  );
});
