import { describe, expect, it } from "vite-plus/test";

import { isAllowed, scanText, type AllowlistEntry } from "./check-brand-identity.ts";

describe("check-brand-identity", () => {
  it("finds every observable legacy identity class", () => {
    const source = [
      "shuv2code",
      "shuv2code",
      "t3-code",
      "@shuv2code/server",
      "SHUV2CODE_HOME",
      "com.t3tools.shuv2code",
      "https://app.shuv.me",
      "T3 Tools, Inc.",
      "npx t3",
      "T3 server",
      ".t3/runtime",
      "t3_rpc_requests_total",
      "t3_relay",
      "t3env_secret",
      "T3ShowcaseScene",
      "shuv2code Tools, Inc.",
      "pingdotgg/shuv2code",
    ].join("\n");

    expect(new Set(scanText("fixture.txt", source).map((match) => match.patternId))).toEqual(
      new Set([
        "legacy-display",
        "legacy-slug",
        "legacy-package-scope",
        "legacy-environment",
        "legacy-app-id",
        "legacy-host",
        "legacy-owner-slug",
        "upstream-owner",
        "legacy-command",
        "legacy-visible-word",
        "legacy-state",
        "legacy-observable-prefix",
        "legacy-relay-kind",
        "legacy-environment-credential",
        "legacy-showcase-identity",
        "invalid-operator",
        "legacy-fork-owner",
      ]),
    );
  });

  it("does not flag the canonical shuv2code identity", () => {
    expect(
      scanText(
        "fixture.txt",
        "shuv2code @shuv2code/server SHUV2CODE_HOME dev.shuv.shuv2code .shuv2code",
      ),
    ).toEqual([]);
  });

  it("requires an exact path and pattern allowlist match", () => {
    const match = scanText("LICENSE", "T3 Tools Inc.").find(
      (candidate) => candidate.patternId === "upstream-owner",
    )!;
    const entries: ReadonlyArray<AllowlistEntry> = [
      {
        path: "LICENSE",
        patternId: "upstream-owner",
        reason: "Required copyright notice.",
      },
    ];

    expect(isAllowed(match, entries)).toBe(true);
    expect(isAllowed({ ...match, path: "README.md" }, entries)).toBe(false);
    expect(isAllowed({ ...match, patternId: "legacy-display" }, entries)).toBe(false);
  });
});
