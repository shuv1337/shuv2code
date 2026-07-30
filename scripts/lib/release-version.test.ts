import { describe, expect, it } from "vite-plus/test";

import {
  InvalidReleaseVersionError,
  ReleaseChannelMismatchError,
  assertReleaseChannel,
  classifyReleaseVersion,
  resolveNightlyCoreVersion,
  resolveNpmDistTag,
} from "./release-version.ts";

describe("classifyReleaseVersion", () => {
  it("maps stable versions only to latest", () => {
    expect(classifyReleaseVersion("0.1.0")).toMatchObject({
      version: "0.1.0",
      class: "stable",
      npmDistTag: "latest",
      githubPrerelease: false,
      githubMakeLatest: true,
    });
    expect(resolveNpmDistTag("0.1.0")).toBe("latest");
  });

  it("maps alpha/beta/rc prereleases only to next", () => {
    for (const version of [
      "0.1.0-alpha.2",
      "0.1.0-beta.1",
      "0.1.0-rc.1",
      "1.0.0-alpha.1",
      "1.0.0-alpha-1+build.9",
    ]) {
      expect(classifyReleaseVersion(version)).toMatchObject({
        version,
        class: "prerelease",
        npmDistTag: "next",
        githubPrerelease: true,
        githubMakeLatest: false,
      });
      expect(resolveNpmDistTag(version)).toBe("next");
    }
  });

  it("maps nightly versions only to nightly", () => {
    expect(classifyReleaseVersion("0.1.0-nightly.20260730.1")).toMatchObject({
      version: "0.1.0-nightly.20260730.1",
      class: "nightly",
      npmDistTag: "nightly",
      githubPrerelease: true,
      githubMakeLatest: false,
    });
    expect(resolveNpmDistTag("0.1.0-nightly.20260730.1")).toBe("nightly");
  });

  it("rejects invalid versions and malformed nightlies", () => {
    for (const version of [
      "nightly",
      "0.1",
      "0.1.0-nightly",
      "0.1.0-nightly.20260730",
      "0.1.0-nightly.20260730.0",
      "0.1.0-nightly.2026073.1",
      "0.1.0-nightly.20260730.1.extra",
      "1.0.0-alpha..1",
      "1.0.0-..",
      "1.0.0-01",
      "1.0.0+???",
      " 1.0.0",
    ]) {
      expect(() => classifyReleaseVersion(version)).toThrow(InvalidReleaseVersionError);
    }
  });
});

describe("assertReleaseChannel", () => {
  it("accepts only the SemVer-derived dist-tag", () => {
    expect(assertReleaseChannel("0.1.0", "latest").npmDistTag).toBe("latest");
    expect(assertReleaseChannel("0.1.0-alpha.2", "next").npmDistTag).toBe("next");
    expect(assertReleaseChannel("0.1.0-nightly.20260730.1", "nightly").npmDistTag).toBe("nightly");
  });

  it("rejects channel mismatches", () => {
    expect(() => assertReleaseChannel("0.1.0-alpha.2", "latest")).toThrow(
      ReleaseChannelMismatchError,
    );
    expect(() => assertReleaseChannel("0.1.0", "next")).toThrow(ReleaseChannelMismatchError);
    expect(() => assertReleaseChannel("0.1.0", "nightly")).toThrow(ReleaseChannelMismatchError);
  });
});

describe("resolveNightlyCoreVersion", () => {
  it("keeps the core version for committed prereleases", () => {
    expect(resolveNightlyCoreVersion("0.1.0-alpha.1")).toBe("0.1.0");
    expect(resolveNightlyCoreVersion("0.1.0-alpha.2")).toBe("0.1.0");
    expect(resolveNightlyCoreVersion("1.2.3-beta.4+build.9")).toBe("1.2.3");
  });

  it("advances the patch for committed stable versions", () => {
    expect(resolveNightlyCoreVersion("0.1.0")).toBe("0.1.1");
    expect(resolveNightlyCoreVersion("0.0.17")).toBe("0.0.18");
  });
});
