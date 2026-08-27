/**
 * ADE ("bot mode") client state for mobile.
 *
 * Deliberately thin: `createAdeEnvironmentAtoms` in
 * `@shuv2code/client-runtime/state/ade` already owns every ADE read, write and
 * subscription, and the web captain surface consumes the same factory. This
 * module only binds it to mobile's connection runtime and answers the one
 * question mobile has to answer differently — *which* environment the fleet
 * lives on.
 *
 * Web keys that on `PrimaryConnectionTarget`, which mobile never mints (it
 * pairs over Bearer/Relay), so `primaryEnvironmentIdAtom` is permanently null
 * here. The mobile answer is the environment the workspace is already looking
 * at: Home's environment filter when the captain has set one, otherwise the
 * connected environment. See `resolveAdeEnvironmentId`.
 */
import type {
  AdeBotDetail,
  AdeNeedsYouCount,
  AdeRoster,
  BotId,
  EnvironmentId,
  FleetHealthSnapshot,
  HealthState,
} from "@shuv2code/contracts";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import { fleetHealthForConnectionPhase } from "@shuv2code/client-runtime/ade/logic";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

export const adeEnvironment = createAdeEnvironmentAtoms(connectionAtomRuntime);

/** The captain's roster, live. A null environment reads nothing. */
export function useAdeRoster(environmentId: EnvironmentId | null): EnvironmentQueryView<AdeRoster> {
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.roster({ environmentId, input: {} }),
  );
}

/** One bot's detail. A null `botId` (or environment) reads nothing. */
export function useAdeBotDetail(
  environmentId: EnvironmentId | null,
  botId: BotId | null,
): EnvironmentQueryView<AdeBotDetail> {
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.bot({ environmentId, input: { botId } }),
  );
}

/** The "Needs You" badge count. PASS 1 shows the number and nothing else. */
export function useAdeNeedsYouCount(
  environmentId: EnvironmentId | null,
): EnvironmentQueryView<AdeNeedsYouCount> {
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.needsYouCount({ environmentId, input: {} }),
  );
}

/**
 * Latest fleet health for one environment, or null while the connection is
 * anything but live — stale health is worse than no health, which is the rule
 * `fleetHealthForConnectionPhase` exists to state once for every client.
 */
export function useAdeFleetHealth(environmentId: EnvironmentId | null): FleetHealthSnapshot | null {
  const connection = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.fleetHealth({ environmentId, input: {} }),
  );
  return fleetHealthForConnectionPhase(connection.data?.phase ?? "available", snapshot.data);
}

/**
 * The shuvcode kernel's health, which is what decides whether opening a
 * conversation may attempt a session at all (`canAutoConnect`).
 */
export function useAdeKernelHealth(environmentId: EnvironmentId | null): HealthState | null {
  const health = useAdeFleetHealth(environmentId);
  return health?.targets.find((target) => target.target === "shuvcode")?.state ?? null;
}
