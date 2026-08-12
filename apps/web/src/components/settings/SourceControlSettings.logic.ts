import type { EnvironmentId, VcsDiscoveryItem, VcsSelectableKind } from "@shuv2code/contracts";

export interface DefaultVcsOption {
  readonly kind: VcsSelectableKind;
  readonly available: boolean;
}

export function resolveDefaultVcsOptions(
  items: ReadonlyArray<VcsDiscoveryItem>,
): ReadonlyArray<DefaultVcsOption> {
  const availableKinds = new Set(
    items
      .filter((item) => item.status === "available" && item.implemented)
      .map((item) => item.kind),
  );
  return (["git", "jj"] as const).map((kind) => ({
    kind,
    available: availableKinds.has(kind),
  }));
}

interface VcsRefreshProject {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

interface VcsRefreshThread {
  readonly environmentId: EnvironmentId;
  readonly worktreePath: string | null;
}

export function resolveDefaultVcsRefreshCwds(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<VcsRefreshProject>;
  readonly threads: ReadonlyArray<VcsRefreshThread>;
}): ReadonlyArray<string> {
  const cwds = new Set<string>();
  for (const project of input.projects) {
    if (project.environmentId === input.environmentId) {
      cwds.add(project.workspaceRoot);
    }
  }
  for (const thread of input.threads) {
    if (thread.environmentId === input.environmentId && thread.worktreePath !== null) {
      cwds.add(thread.worktreePath);
    }
  }
  return [...cwds];
}

interface SettledCommandResult {
  readonly _tag: string;
}

export async function updateDefaultVcsKindAndRefresh<TResult extends SettledCommandResult>(input: {
  readonly environmentId: EnvironmentId;
  readonly kind: VcsSelectableKind;
  readonly refreshCwds: ReadonlyArray<string>;
  readonly updateSettings: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly patch: { readonly defaultVcsKind: VcsSelectableKind } };
  }) => Promise<TResult>;
  readonly refreshStatus: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string };
  }) => Promise<unknown>;
}): Promise<TResult> {
  const result = await input.updateSettings({
    environmentId: input.environmentId,
    input: { patch: { defaultVcsKind: input.kind } },
  });
  if (result._tag !== "Success") {
    return result;
  }

  // refreshStatus also invalidates the matching listRefs cache when the command settles.
  await Promise.all(
    input.refreshCwds.map((cwd) =>
      input.refreshStatus({
        environmentId: input.environmentId,
        input: { cwd },
      }),
    ),
  );
  return result;
}
