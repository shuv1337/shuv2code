/**
 * Pure view mapping for the sidebar kernel health pills (spec §4.8, §7.8):
 * one pill per monitored target, fed by the server's health checker over WS.
 */
import type { FleetHealthSnapshot, HealthState, HealthTargetId } from "@shuv2code/contracts";

export interface KernelHealthPillView {
  readonly target: HealthTargetId;
  readonly label: string;
  readonly state: HealthState;
  readonly dotClassName: string;
  readonly pingClassName: string | null;
  readonly tooltip: string;
}

const TARGET_ORDER: ReadonlyArray<HealthTargetId> = ["shuvcode", "codex", "screenbox"];

const TARGET_LABELS: Record<HealthTargetId, string> = {
  shuvcode: "shuvcode",
  codex: "Codex",
  screenbox: "Screen",
};

const TARGET_TITLES: Record<HealthTargetId, string> = {
  shuvcode: "shuvcode kernel",
  codex: "Codex kernel",
  screenbox: "Screenbox runtime",
};

const STATE_TEXT: Record<HealthState, string> = {
  healthy: "healthy",
  down: "down",
  "not-provisioned": "not provisioned",
  unknown: "checking…",
};

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

function pillView(target: HealthTargetId, state: HealthState, detail: string | null) {
  const summary = `${TARGET_TITLES[target]}: ${STATE_TEXT[state]}`;
  return {
    target,
    label: TARGET_LABELS[target],
    state,
    dotClassName: STATE_DOT_CLASS[state],
    pingClassName: STATE_PING_CLASS[state],
    tooltip: detail === null || detail.length === 0 ? summary : `${summary}\n${detail}`,
  } satisfies KernelHealthPillView;
}

/**
 * All three pills in fixed order. A missing snapshot (not yet received or
 * disconnected) renders every target as `unknown` — the app never gates on
 * health (spec §4.1 no-kernel-gate), so the row is always present.
 */
export function getKernelHealthPillViews(
  snapshot: FleetHealthSnapshot | null,
): ReadonlyArray<KernelHealthPillView> {
  return TARGET_ORDER.map((target) => {
    const entry = snapshot?.targets.find((candidate) => candidate.target === target);
    return entry === undefined
      ? pillView(target, "unknown", null)
      : pillView(target, entry.state, entry.detail);
  });
}
