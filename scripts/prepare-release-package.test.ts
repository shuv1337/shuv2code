import { assert, describe, it } from "@effect/vitest";

import {
  ReleasePackagePreparationError,
  createReleasePackageManifest,
} from "./prepare-release-package.ts";

const sourceManifest = {
  name: "shuv2code",
  version: "0.1.0-alpha.1",
  description: "Local-first coding agent server and CLI for shuv2code",
  license: "MIT",
  bin: {
    shuv2code: "./dist/bin.mjs",
    s2c: "./dist/bin.mjs",
  },
  files: ["dist", "README.md", "LICENSE"],
  type: "module",
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
  },
  engines: { node: "^22.16 || ^23.11 || >=24.10" },
  dependencies: {
    effect: "catalog:",
    yaml: "catalog:",
    "node-pty": "^1.1.0",
  },
  scripts: { typecheck: "tsgo --noEmit" },
  devDependencies: {
    "@shuv2code/shared": "workspace:*",
    "effect-acp": "workspace:*",
  },
  overrides: { "node-pty": "1.1.0" },
};

describe("release package preparation", () => {
  it("creates a minimal publication manifest with resolved runtime dependencies", () => {
    const manifest = createReleasePackageManifest(
      sourceManifest,
      { effect: "4.0.0-beta.102", yaml: "^2.9.0" },
      "0.1.0-alpha.1",
    );

    assert.deepEqual(manifest.dependencies, {
      effect: "4.0.0-beta.102",
      yaml: "^2.9.0",
      "node-pty": "^1.1.0",
    });
    assert.notProperty(manifest, "devDependencies");
    assert.notProperty(manifest, "scripts");
    assert.notProperty(manifest, "overrides");
    assert.equal(manifest.version, "0.1.0-alpha.1");
  });

  it("rejects a source manifest that is not aligned to the resolved release", () => {
    assert.throws(
      () =>
        createReleasePackageManifest(
          sourceManifest,
          { effect: "4.0.0-beta.102", yaml: "^2.9.0" },
          "0.1.0-alpha.2",
        ),
      ReleasePackagePreparationError,
    );
  });

  it("fails when a runtime catalog dependency is unresolved", () => {
    assert.throws(
      () => createReleasePackageManifest(sourceManifest, {}, "0.1.0-alpha.1"),
      /Unable to resolve/,
    );
  });
});
