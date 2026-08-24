import type { FleetHealthSnapshot } from "@shuv2code/contracts";
import type { SupervisorConnectionState } from "@shuv2code/client-runtime/connection";

/**
 * The fleet-health subscription atom retains its last success while the
 * WebSocket re-establishes, but stale health is worse than no health — a
 * "healthy" pill during an outage of the connection itself is a lie.
 * Anything but a live `connected` phase reads as no snapshot, so the pills
 * fall back to `unknown` until the resubscribed feed pushes fresh state.
 */
export function fleetHealthForConnectionPhase(
  phase: SupervisorConnectionState["phase"],
  snapshot: FleetHealthSnapshot | null,
): FleetHealthSnapshot | null {
  return phase === "connected" ? snapshot : null;
}
