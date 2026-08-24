/**
 * ADE client state (spec `docs/ade/ADE-V1-SPEC.md` §4.8, §7.8): the fleet
 * health subscription backing the sidebar kernel pills. First ADE atom
 * module; later slices (roster, assignments, Needs You) extend it.
 */
import type { Atom } from "effect/unstable/reactivity";

import { WS_METHODS } from "@shuv2code/contracts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

export function createAdeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Latest `FleetHealthSnapshot` pushed by the server's health checker.
     * `idleTtlMs: 0` keeps the pill feed live while any subscriber exists and
     * drops the subscription as soon as the last pill unmounts.
     */
    fleetHealth: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ade:fleet-health",
      tag: WS_METHODS.subscribeAdeFleetHealth,
      idleTtlMs: 0,
    }),
  };
}
