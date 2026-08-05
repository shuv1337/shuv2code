import type { VcsStatusResult } from "@shuv2code/contracts";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
} from "./BranchToolbar.logic";
import { resolveJjActionAvailability, resolveJjWorkingCopyLabel } from "./GitActionsControl.logic";

function jjStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    kind: "jj",
    capabilities: {
      kind: "jj",
      supportsWorktrees: true,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: false,
      supportsStatus: true,
      supportsRefMutation: true,
      supportsWorkspaceMutation: true,
      supportsDescribeChange: true,
      supportsStartChange: true,
      supportsFetch: true,
      supportsPush: true,
      supportsChangeRequests: true,
      supportsJuzu: true,
      ignoreClassifier: "git-compatible-fallback",
    },
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/native",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    workingCopy: {
      changeId: "wxyz1234",
      commitId: "0123456789abcdef",
      description: "Native JJ change",
      workspaceName: "feature-workspace",
      isEmpty: false,
      hasConflicts: false,
      conflictPaths: [],
      bookmarks: ["feature/native"],
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 1,
    pr: null,
    ...overrides,
  };
}

it("uses change, bookmark, and workspace terminology for JJ", () => {
  expect(resolveEnvModeLabel("local", "jj")).toBe("Current workspace");
  expect(resolveEnvModeLabel("worktree", "jj")).toBe("New workspace");
  expect(resolveCurrentWorkspaceLabel("/repo/workspace", "jj")).toBe("Current workspace");
  expect(resolveLockedWorkspaceLabel("/repo/workspace", "jj")).toBe("Workspace");
  expect(resolveJjWorkingCopyLabel(jjStatus())).toBe("Change wxyz1234 · bookmarks feature/native");
  expect(
    resolveJjWorkingCopyLabel(
      jjStatus({ workingCopy: { ...jjStatus().workingCopy!, bookmarks: [] } }),
    ),
  ).toBe("Anonymous change wxyz1234 · no bookmark");
});

it("capability-gates JJ push and change-request actions with actionable reasons", () => {
  expect(resolveJjActionAvailability(jjStatus())).toMatchObject({
    canDescribe: true,
    canStartChange: true,
    canFetch: true,
    canPush: true,
    canCreateChangeRequest: true,
    pushUnavailableReason: null,
  });

  const conflict = jjStatus({
    workingCopy: {
      ...jjStatus().workingCopy!,
      hasConflicts: true,
      conflictPaths: ["conflict.txt"],
    },
  });
  expect(resolveJjActionAvailability(conflict).pushUnavailableReason).toContain("conflicts");

  const anonymous = jjStatus({
    workingCopy: { ...jjStatus().workingCopy!, bookmarks: [] },
  });
  expect(resolveJjActionAvailability(anonymous).pushUnavailableReason).toContain("bookmark");

  const unsupported = jjStatus({
    capabilities: { ...jjStatus().capabilities!, supportsChangeRequests: false },
  });
  expect(resolveJjActionAvailability(unsupported).canCreateChangeRequest).toBe(false);
});
