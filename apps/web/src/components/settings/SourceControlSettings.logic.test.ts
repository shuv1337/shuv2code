import { describe, expect, it } from "vite-plus/test";
import type { VcsDiscoveryItem } from "@shuv2code/contracts";
import * as Option from "effect/Option";

import { resolveDefaultVcsOptions } from "./SourceControlSettings.logic";

function discoveryItem(
  kind: "git" | "jj",
  status: "available" | "missing",
  implemented = true,
): VcsDiscoveryItem {
  return {
    kind,
    label: kind === "git" ? "Git" : "Jujutsu",
    implemented,
    status,
    version: Option.none(),
    installHint: `Install ${kind}`,
    detail: Option.none(),
  };
}

describe("resolveDefaultVcsOptions", () => {
  it("keeps Git and Jujutsu as independent choices when both are available", () => {
    expect(
      resolveDefaultVcsOptions([
        discoveryItem("git", "available"),
        discoveryItem("jj", "available"),
      ]),
    ).toEqual([
      { kind: "git", available: true },
      { kind: "jj", available: true },
    ]);
  });

  it("disables only the missing or unsupported choice", () => {
    expect(
      resolveDefaultVcsOptions([
        discoveryItem("git", "available"),
        discoveryItem("jj", "available", false),
      ]),
    ).toEqual([
      { kind: "git", available: true },
      { kind: "jj", available: false },
    ]);
  });
});
