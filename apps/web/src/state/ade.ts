import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import { createAdeEnvironmentAtoms } from "@shuv2code/client-runtime/state/ade";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const adeEnvironment = createAdeEnvironmentAtoms(connectionAtomRuntime);

/**
 * Latest fleet health pushed by the primary environment's health checker
 * (spec §4.8); null before the first snapshot arrives or when disconnected —
 * the pills render every target as `unknown` in that case.
 */
export const primaryFleetHealthAtom = Atom.make((get): FleetHealthSnapshot | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(get(adeEnvironment.fleetHealth({ environmentId, input: {} }))),
  );
}).pipe(Atom.withLabel("web-primary-ade-fleet-health"));
