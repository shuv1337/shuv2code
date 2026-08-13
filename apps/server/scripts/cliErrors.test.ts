import { assert, describe, it } from "@effect/vitest";

import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconTargetMissingError,
} from "./cliErrors.ts";

describe("server CLI errors", () => {
  it("preserves failed command context without changing its message", () => {
    const error = new ServerCliCommandExitError({
      command: process.execPath,
      args: ["--run", "build:bundle"],
      cwd: "/repo",
      exitCode: 17,
    });

    assert.equal(error._tag, "ServerCliCommandExitError");
    assert.equal(error.command, process.execPath);
    assert.deepEqual(error.args, ["--run", "build:bundle"]);
    assert.equal(error.cwd, "/repo");
    assert.equal(error.exitCode, 17);
    assert.equal(error.message, "Command exited with non-zero exit code (17)");
  });

  it("preserves a representative missing development icon path", () => {
    const error = new ServerCliDevelopmentIconTargetMissingError({
      targetPath: "/repo/dist/client/favicon.ico",
    });

    assert.equal(error.targetPath, "/repo/dist/client/favicon.ico");
    assert.equal(
      error.message,
      "Missing development icon target: /repo/dist/client/favicon.ico. Build web first.",
    );
  });

  it("preserves a missing build asset path", () => {
    const error = new ServerCliBuildAssetMissingError({
      assetPath: "/repo/dist/service-launcher.mjs",
    });

    assert.equal(error.assetPath, "/repo/dist/service-launcher.mjs");
    assert.equal(error.message, "Missing server build asset: /repo/dist/service-launcher.mjs");
  });
});
