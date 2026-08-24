import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@shuv2code/client-runtime/connection";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { fleetHealthForConnectionPhase } from "./ade.logic";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

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
