import type {
  AdeBotDetail,
  AdeNeedsYouCount,
  AdeRoster,
  BotId,
  FleetHealthSnapshot,
} from "@shuv2code/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@shuv2code/client-runtime/connection";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { fleetHealthForConnectionPhase } from "./ade.logic";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

export const adeEnvironment = createAdeEnvironmentAtoms(connectionAtomRuntime);

/**
 * Latest fleet health pushed by the primary environment's health checker
 * (spec §4.8); null before the first snapshot arrives, when disconnected, or
 * while reconnecting — the pills render every target as `unknown` then.
 */
export const primaryFleetHealthAtom = Atom.make((get): FleetHealthSnapshot | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  const connection = Option.getOrElse(
    AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const snapshot = Option.getOrNull(
    AsyncResult.value(get(adeEnvironment.fleetHealth({ environmentId, input: {} }))),
  );
  return fleetHealthForConnectionPhase(connection.phase, snapshot);
}).pipe(Atom.withLabel("web-primary-ade-fleet-health"));

/**
 * The ADE fleet lives on the primary environment only: bots, assignments and
 * memory are server-local records, and a captain surface pointed at a second
 * server would be reading a different fleet entirely.
 */
export function useAdeEnvironmentId() {
  return useAtomValue(primaryEnvironmentIdAtom);
}

/** The captain's roster (UI slice 2); null data until the primary answers. */
export function useAdeRoster(): EnvironmentQueryView<AdeRoster> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.roster({ environmentId, input: {} }),
  );
}

/** One bot's detail (UI slice 2). A null `botId` reads nothing. */
export function useAdeBotDetail(botId: BotId | null): EnvironmentQueryView<AdeBotDetail> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || botId === null
      ? null
      : adeEnvironment.bot({ environmentId, input: { botId } }),
  );
}

/** Sidebar "Needs You" badge count (UI slice 8), polled by the query atom. */
export function useAdeNeedsYouCount(): EnvironmentQueryView<AdeNeedsYouCount> {
  const environmentId = useAdeEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : adeEnvironment.needsYouCount({ environmentId, input: {} }),
  );
}
