import type { EnvironmentId } from "@shuv2code/contracts";
import { useMemo } from "react";

import { useWorkspaceState } from "../../state/workspace";
import { useHomeListOptions } from "../home/home-list-options";
import { resolveAdeEnvironmentId } from "./fleet.logic";

/**
 * Which environment bot mode reads the fleet from.
 *
 * Deliberately the *same* selection Home's environment filter drives — that
 * context is mounted by `AdaptiveWorkspaceLayout` above every route, so "which
 * server am I looking at" has one answer for the whole workspace instead of
 * two that can disagree. The precedence itself is `resolveAdeEnvironmentId`,
 * which is pure and tested.
 */
export function useAdeEnvironmentId(): EnvironmentId | null {
  const { environments } = useWorkspaceState();
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options } = useHomeListOptions(availableEnvironmentIds);
  return useMemo(
    () =>
      resolveAdeEnvironmentId({
        environments: environments.map((environment) => ({
          environmentId: environment.environmentId,
          connectionState: environment.connectionState,
        })),
        preferredEnvironmentId: options.selectedEnvironmentId,
      }),
    [environments, options.selectedEnvironmentId],
  );
}
