import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { VcsError } from "@shuv2code/contracts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const JjContractLayer = JjVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

type JjContractError = VcsError | PlatformError.PlatformError;

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

runVcsDriverContractSuite<VcsDriver.VcsDriver, JjContractError>({
  name: "Jujutsu",
  kind: "jj",
  layer: JjContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        yield* driver.initRepository({ cwd, kind: "jj" });
      }),
    writeFile,
    ignorePath: (cwd, pattern) => writeFile(cwd, ".gitignore", `${pattern}\n`),
  },
});

it.effect("builds review previews from the jj working-copy change", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "shuv2code-jj-review-",
    });
    const driver = yield* VcsDriver.VcsDriver;

    yield* driver.initRepository({ cwd, kind: "jj" });
    yield* writeFile(cwd, "review.txt", "review me\n");

    const getDiffPreview = driver.getDiffPreview;
    assert.ok(getDiffPreview);
    const preview = yield* getDiffPreview({ cwd });
    assert.equal(preview.sources[0]?.title, "Working-copy change (@)");
    assert.include(preview.sources[0]?.diff ?? "", "review.txt");
    assert.equal(preview.sources[0]?.headRef, "@");
  }).pipe(Effect.provide(JjContractLayer)),
);

it.effect("fails closed when JJ bookmark output is truncated", () =>
  Effect.gen(function* () {
    const driver = yield* JjVcsDriver.makeVcsDriver;
    const listRefs = driver.listRefs;
    assert.ok(listRefs);

    const error = yield* listRefs({ cwd: "/virtual/repo" }).pipe(Effect.flip);
    assert.include(error.message, "bookmark output was truncated");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) => {
            const isBookmarkList =
              input.command === "jj" &&
              input.args.includes("bookmark") &&
              input.args.includes("--all-remotes");
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: isBookmarkList
                ? '{"name":"main","target":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}\n'
                : '{"commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","changeId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","description":"","empty":true,"conflict":false,"conflictPaths":[]}\n',
              stderr: "",
              stdoutTruncated: isBookmarkList,
              stderrTruncated: false,
            });
          },
        }),
      ),
    ),
  ),
);
