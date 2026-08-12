import { describe, expect, it } from "vite-plus/test";

import {
  canUseGitOnlyActions,
  sourceControlRefLabel,
  sourceControlReviewDetail,
  sourceControlReviewSummary,
  sourceControlWorkspaceLabel,
} from "./git-action-availability";

describe("canUseGitOnlyActions", () => {
  it("allows Git and rolling-compatible legacy statuses", () => {
    expect(canUseGitOnlyActions({ kind: "git" })).toBe(true);
    expect(canUseGitOnlyActions({})).toBe(true);
  });

  it("rejects explicit non-Git drivers and missing status", () => {
    expect(canUseGitOnlyActions({ kind: "jj" })).toBe(false);
    expect(canUseGitOnlyActions({ kind: "unknown" })).toBe(false);
    expect(canUseGitOnlyActions(null)).toBe(false);
    expect(canUseGitOnlyActions(undefined)).toBe(false);
  });
});

describe("sourceControlRefLabel", () => {
  it("uses bookmark-aware wording for Jujutsu", () => {
    expect(sourceControlRefLabel({ kind: "jj", refName: "feature/mobile" }, "stale-branch")).toBe(
      "feature/mobile",
    );
    expect(sourceControlRefLabel({ kind: "jj", refName: null }, "stale-branch")).toBe(
      "Unbookmarked change",
    );
  });

  it("preserves Git and legacy detached-head wording", () => {
    expect(sourceControlRefLabel({ kind: "git", refName: null }, "feature/mobile")).toBe(
      "feature/mobile",
    );
    expect(sourceControlRefLabel({}, null)).toBe("Detached HEAD");
    expect(sourceControlRefLabel({ kind: "unknown" }, null)).toBe("No active ref");
  });
});

describe("source-control terminology", () => {
  it("uses working-copy and workspace language for Jujutsu", () => {
    const status = { kind: "jj" as const };
    expect(sourceControlReviewSummary(status)).toBe("Turn diffs and working-copy changes");
    expect(sourceControlReviewDetail(status)).toBe(
      "Inspect turn diffs, working-copy changes, and trunk diff",
    );
    expect(sourceControlWorkspaceLabel(status)).toBe("Workspace");
  });

  it("preserves existing Git and rolling-compatible legacy language", () => {
    for (const status of [{ kind: "git" as const }, {}]) {
      expect(sourceControlReviewSummary(status)).toBe("Turn diffs and worktree changes");
      expect(sourceControlReviewDetail(status)).toBe(
        "Inspect turn diffs, worktree changes, and base branch diff",
      );
      expect(sourceControlWorkspaceLabel(status)).toBe("Worktree");
    }
  });
});
