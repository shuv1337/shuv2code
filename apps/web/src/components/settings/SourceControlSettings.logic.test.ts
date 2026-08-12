import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type VcsDiscoveryItem } from "@shuv2code/contracts";
import * as Option from "effect/Option";

import {
  resolveDefaultVcsOptions,
  resolveDefaultVcsRefreshCwds,
  updateDefaultVcsKindAndRefresh,
} from "./SourceControlSettings.logic";

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

describe("default VCS refresh", () => {
  const primaryEnvironmentId = EnvironmentId.make("primary");
  const remoteEnvironmentId = EnvironmentId.make("remote");

  it("deduplicates primary project roots and active worktree paths", () => {
    expect(
      resolveDefaultVcsRefreshCwds({
        environmentId: primaryEnvironmentId,
        projects: [
          { environmentId: primaryEnvironmentId, workspaceRoot: "/repo" },
          { environmentId: remoteEnvironmentId, workspaceRoot: "/remote" },
        ],
        threads: [
          { environmentId: primaryEnvironmentId, worktreePath: "/repo/worktree" },
          { environmentId: primaryEnvironmentId, worktreePath: "/repo/worktree" },
          { environmentId: primaryEnvironmentId, worktreePath: null },
          { environmentId: remoteEnvironmentId, worktreePath: "/remote/worktree" },
        ],
      }),
    ).toEqual(["/repo", "/repo/worktree"]);
  });

  it("waits for the setting write before refreshing every affected status", async () => {
    const calls: string[] = [];
    const updateSettings = vi.fn(async () => {
      calls.push("settings");
      return { _tag: "Success" as const };
    });
    const refreshStatus = vi.fn(async ({ input }: { input: { cwd: string } }) => {
      calls.push(`status:${input.cwd}`);
      return { _tag: "Success" as const };
    });

    await updateDefaultVcsKindAndRefresh({
      environmentId: primaryEnvironmentId,
      kind: "jj",
      refreshCwds: ["/repo", "/repo/worktree"],
      updateSettings,
      refreshStatus,
    });

    expect(calls).toEqual(["settings", "status:/repo", "status:/repo/worktree"]);
    expect(updateSettings).toHaveBeenCalledWith({
      environmentId: primaryEnvironmentId,
      input: { patch: { defaultVcsKind: "jj" } },
    });
    expect(refreshStatus).toHaveBeenNthCalledWith(1, {
      environmentId: primaryEnvironmentId,
      input: { cwd: "/repo" },
    });
    expect(refreshStatus).toHaveBeenNthCalledWith(2, {
      environmentId: primaryEnvironmentId,
      input: { cwd: "/repo/worktree" },
    });
  });

  it("keeps current status and ref caches untouched when the setting write fails", async () => {
    const refreshStatus = vi.fn();

    await updateDefaultVcsKindAndRefresh({
      environmentId: primaryEnvironmentId,
      kind: "jj",
      refreshCwds: ["/repo"],
      updateSettings: async () => ({ _tag: "Failure" as const }),
      refreshStatus,
    });

    expect(refreshStatus).not.toHaveBeenCalled();
  });
});
