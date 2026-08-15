import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

it.effect("keeps JJ refs available when a remote bookmark target is absent", () =>
  Effect.gen(function* () {
    const driver = yield* JjVcsDriver.makeVcsDriver;
    const listRefs = driver.listRefs;
    assert.ok(listRefs);

    const result = yield* listRefs({ cwd: "/virtual/repo" });
    assert.equal(result.isRepo, true);
    assert.equal(result.totalCount, 2);
    assert.equal(result.refs[0]?.name, "main");
    assert.equal(result.refs[1]?.name, "main@origin");
    assert.equal(result.refs[1]?.targetCommitId, null);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) => {
            const stdout = input.args.includes("bookmark")
              ? [
                  '{"name":"main","target":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}',
                  '{"name":"main","remote":"origin","target":[null],"tracking_target":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}',
                ].join("\n") + "\n"
              : input.args.includes("remote")
                ? "origin https://example.com/repo.git\n"
                : input.args.some((arg) => arg.includes("commitId"))
                  ? '{"commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","changeId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","description":"","empty":true,"conflict":false,"conflictPaths":[]}\n'
                  : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
      ),
    ),
  ),
);
