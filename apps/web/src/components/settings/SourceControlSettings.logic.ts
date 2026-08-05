import type { VcsDiscoveryItem, VcsSelectableKind } from "@shuv2code/contracts";

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
