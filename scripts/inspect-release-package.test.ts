// @effect-diagnostics nodeBuiltinImport:off - Tests exercise exact artifact bytes and temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  ReleasePackageInspectionError,
  computeFileSha256,
  parseCliOptions,
  validatePackedPackage,
} from "./inspect-release-package.ts";

const expectedFiles = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/bin.mjs",
  "package/dist/client/index.html",
  "package/dist/client/assets/index.js",
];

const validManifest = {
  name: "shuv2code",
  version: "0.1.0-alpha.1",
  bin: {
    shuv2code: "./dist/bin.mjs",
    s2c: "./dist/bin.mjs",
  },
  dependencies: {
    effect: "4.0.0-beta.102",
    yaml: "^2.9.0",
  },
};

describe("release package inspection", () => {
  it("accepts the intended manifest and package contents", () => {
    assert.deepEqual(validatePackedPackage(validManifest, expectedFiles, "0.1.0-alpha.1"), {
      name: "shuv2code",
      version: "0.1.0-alpha.1",
      fileCount: expectedFiles.length,
    });
  });

  it("rejects unresolved workspace metadata and private runtime dependencies", () => {
    assert.throws(
      () =>
        validatePackedPackage(
          { ...validManifest, dependencies: { effect: "catalog:" } },
          expectedFiles,
          "0.1.0-alpha.1",
        ),
      ReleasePackageInspectionError,
    );
    assert.throws(
      () =>
        validatePackedPackage(
          { ...validManifest, dependencies: { "@shuv2code/shared": "0.1.0-alpha.1" } },
          expectedFiles,
          "0.1.0-alpha.1",
        ),
      /private dependency/,
    );
    assert.throws(
      () =>
        validatePackedPackage(
          {
            ...validManifest,
            devDependencies: { "@shuv2code/shared": "0.1.0-alpha.1" },
          },
          expectedFiles,
          "0.1.0-alpha.1",
        ),
      /devDependencies/,
    );
  });

  it("rejects missing release assets and sensitive paths", () => {
    assert.throws(
      () =>
        validatePackedPackage(
          validManifest,
          expectedFiles.filter((file) => file !== "package/dist/client/index.html"),
          "0.1.0-alpha.1",
        ),
      /missing 'package\/dist\/client\/index.html'/,
    );
    assert.throws(
      () =>
        validatePackedPackage(
          validManifest,
          [...expectedFiles, "package/.env.production"],
          "0.1.0-alpha.1",
        ),
      /sensitive path/,
    );
  });

  it("rejects wrong versions and incomplete bin mappings", () => {
    assert.throws(
      () => validatePackedPackage(validManifest, expectedFiles, "0.1.0-alpha.2"),
      /Expected packed package version/,
    );
    assert.throws(
      () =>
        validatePackedPackage(
          { ...validManifest, bin: { shuv2code: "./dist/bin.mjs" } },
          expectedFiles,
          "0.1.0-alpha.1",
        ),
      /bin 's2c'/,
    );
  });

  it("rejects malformed, unknown, and duplicate CLI flags", () => {
    assert.throws(() => parseCliOptions(["--tarball", "package.tgz", "--version"]), /Usage:/);
    assert.throws(
      () =>
        parseCliOptions([
          "--tarball",
          "--version",
          "--version",
          "0.1.0",
          "--digest-output",
          "digest.txt",
        ]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseCliOptions([
          "--tarball",
          "package.tgz",
          "--wat",
          "value",
          "--digest-output",
          "digest.txt",
        ]),
      /Usage:/,
    );
  });

  it("parses the complete CLI contract", () => {
    assert.deepEqual(
      parseCliOptions([
        "--tarball",
        "package.tgz",
        "--version",
        "0.1.0-alpha.1",
        "--digest-output",
        "package.sha256",
      ]),
      {
        tarballPath: NodePath.resolve("package.tgz"),
        version: "0.1.0-alpha.1",
        digestOutputPath: NodePath.resolve("package.sha256"),
      },
    );
  });

  it("computes the SHA-256 digest of the exact file bytes", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-digest-test-"));
    try {
      const filePath = NodePath.join(tempRoot, "package.tgz");
      NodeFS.writeFileSync(filePath, "reviewed tarball bytes");
      assert.equal(
        computeFileSha256(filePath),
        NodeCrypto.createHash("sha256").update("reviewed tarball bytes").digest("hex"),
      );
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
