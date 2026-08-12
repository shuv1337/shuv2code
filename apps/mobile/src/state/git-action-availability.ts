import type { VcsStatusResult } from "@shuv2code/contracts";

export function canUseGitOnlyActions(
  status: Pick<VcsStatusResult, "kind"> | null | undefined,
): boolean {
  if (status == null) {
    return false;
  }

  // `kind` is optional on the wire for rolling compatibility. Statuses from
  // older servers are Git statuses, while explicit non-Git drivers must fail
  // closed.
  return status.kind === undefined || status.kind === "git";
}

export function sourceControlRefLabel(
  status: Partial<Pick<VcsStatusResult, "kind" | "refName">> | null | undefined,
  fallbackRef: string | null | undefined,
): string {
  if (status?.kind === "jj") {
    return status.refName ?? "Unbookmarked change";
  }

  return (
    status?.refName ??
    fallbackRef ??
    (status?.kind === "unknown" ? "No active ref" : "Detached HEAD")
  );
}

type SourceControlKindStatus = Partial<Pick<VcsStatusResult, "kind">> | null | undefined;

export function sourceControlReviewSummary(status: SourceControlKindStatus): string {
  return status?.kind === "jj"
    ? "Turn diffs and working-copy changes"
    : "Turn diffs and worktree changes";
}

export function sourceControlReviewDetail(status: SourceControlKindStatus): string {
  return status?.kind === "jj"
    ? "Inspect turn diffs, working-copy changes, and trunk diff"
    : "Inspect turn diffs, worktree changes, and base branch diff";
}

export function sourceControlWorkspaceLabel(status: SourceControlKindStatus): string {
  return status?.kind === "jj" ? "Workspace" : "Worktree";
}
