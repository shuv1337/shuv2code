import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { CheckpointRef, type VcsError } from "@shuv2code/contracts";
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

it.effect("captures stable jj checkpoints, diffs them, and restores their contents", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "shuv2code-jj-checkpoint-",
    });
    const driver = yield* VcsDriver.VcsDriver;
    const checkpoints = driver.checkpoints;
    assert.ok(checkpoints);

    yield* driver.initRepository({ cwd, kind: "jj" });
    yield* writeFile(cwd, "note.txt", "one\n");

    const first = CheckpointRef.make("refs/shuv2code/checkpoints/test/turn/1");
    const second = CheckpointRef.make("refs/shuv2code/checkpoints/test/turn/2");
    yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: first });

    yield* writeFile(cwd, "note.txt", "two\n");
    yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: second });

    const diff = yield* checkpoints.diffCheckpoints({
      cwd,
      fromCheckpointRef: first,
      toCheckpointRef: second,
      ignoreWhitespace: false,
    });
    assert.include(diff, "-one");
    assert.include(diff, "+two");

    assert.isTrue(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: first }));
    assert.equal(yield* fileSystem.readFileString(path.join(cwd, "note.txt")), "one\n");

    yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: [first, second] });
    assert.isFalse(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: first }));
  }).pipe(Effect.provide(JjContractLayer)),
);

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
