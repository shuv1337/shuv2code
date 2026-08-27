/**
 * Pure view mapping for the sidebar kernel health pills (spec §4.8, §7.8):
 * one pill per monitored target, fed by the server's health checker over WS.
 *
 * The vocabulary — order, labels, the sentence each state turns into — is
 * `@shuv2code/client-runtime/ade/kernel-health`, shared with the mobile fleet
 * surface. What stays here is the paint: these are Tailwind classes for a
 * browser stylesheet, and React Native resolves neither `bg-muted-foreground/40`
 * nor the ping animation they drive.
 */
import type { FleetHealthSnapshot, HealthState, HealthTargetId } from "@shuv2code/contracts";
import { getKernelHealthTargetViews } from "@shuv2code/client-runtime/ade/kernel-health";

export interface KernelHealthPillView {
  readonly target: HealthTargetId;
  readonly label: string;
  readonly state: HealthState;
  readonly dotClassName: string;
  readonly pingClassName: string | null;
  readonly tooltip: string;
}

const STATE_DOT_CLASS: Record<HealthState, string> = {
  healthy: "bg-success",
  down: "bg-destructive",
  "not-provisioned": "bg-muted-foreground/40",
  unknown: "bg-muted-foreground/40",
};

/** Ping halo only for an outage; dormant/unknown stay quiet. */
const STATE_PING_CLASS: Record<HealthState, string | null> = {
  healthy: null,
  down: "bg-destructive/60 duration-2000",
  "not-provisioned": null,
  unknown: null,
};

/**
 * All three pills in fixed order. A missing snapshot (not yet received or
 * disconnected) renders every target as `unknown` — the app never gates on
 * health (spec §4.1 no-kernel-gate), so the row is always present.
 */
export function getKernelHealthPillViews(
  snapshot: FleetHealthSnapshot | null,
): ReadonlyArray<KernelHealthPillView> {
  return getKernelHealthTargetViews(snapshot).map(
    (view): KernelHealthPillView => ({
      target: view.target,
      label: view.label,
      state: view.state,
      dotClassName: STATE_DOT_CLASS[view.state],
      pingClassName: STATE_PING_CLASS[view.state],
      tooltip: view.detail === null ? view.summary : `${view.summary}\n${view.detail}`,
    }),
  );
}
