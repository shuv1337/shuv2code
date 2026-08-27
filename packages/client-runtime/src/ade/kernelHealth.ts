/**
 * What the fleet-health snapshot *says*, shared by every client (spec §4.8,
 * §7.8).
 *
 * The split here is deliberate and is the reason this module exists rather than
 * a second copy on the phone: target order, the names a captain reads, and the
 * sentence each state turns into are facts about the fleet, while the colour
 * classes that paint them are facts about a stylesheet — web's Tailwind and
 * mobile's Uniwind resolve different tokens and React Native cannot use half of
 * web's. So the vocabulary lives here and each client maps a `HealthState` to
 * its own paint.
 *
 * The one behaviour both clients must share is the fallback: a missing snapshot
 * renders every target as `unknown` rather than hiding the row. The app is
 * never gated on kernel health (spec §4.1), so "we have not heard yet" has to
 * be sayable — an absent row would read as "everything is fine".
 */
import type { FleetHealthSnapshot, HealthState, HealthTargetId } from "@shuv2code/contracts";

/** Fixed render order, so no surface invents its own priority. */
export const HEALTH_TARGET_ORDER: ReadonlyArray<HealthTargetId> = [
  "shuvcode",
  "codex",
  "screenbox",
];

/** Compact label, for a pill with a few characters of room. */
export const HEALTH_TARGET_LABELS: Record<HealthTargetId, string> = {
  shuvcode: "shuvcode",
  codex: "Codex",
  screenbox: "Screen",
};

/** Full name, for a tooltip or a settings-style row. */
export const HEALTH_TARGET_TITLES: Record<HealthTargetId, string> = {
  shuvcode: "shuvcode kernel",
  codex: "Codex kernel",
  screenbox: "Screenbox runtime",
};

export const HEALTH_STATE_TEXT: Record<HealthState, string> = {
  healthy: "healthy",
  down: "down",
  "not-provisioned": "not provisioned",
  unknown: "checking…",
};

/** One target, as any client renders it before it picks colours. */
export interface KernelHealthTargetView {
  readonly target: HealthTargetId;
  readonly label: string;
  readonly title: string;
  readonly state: HealthState;
  readonly stateText: string;
  /** "shuvcode kernel: down" — the one line both a tooltip and a row use. */
  readonly summary: string;
  /** The probe's own words, when it had any. */
  readonly detail: string | null;
}

/**
 * All three targets in fixed order. A missing snapshot — not yet received, or
 * the connection itself is down — renders every one as `unknown`.
 */
export function getKernelHealthTargetViews(
  snapshot: FleetHealthSnapshot | null,
): ReadonlyArray<KernelHealthTargetView> {
  return HEALTH_TARGET_ORDER.map((target) => {
    const entry = snapshot?.targets.find((candidate) => candidate.target === target);
    const state = entry?.state ?? "unknown";
    const detail = entry?.detail ?? null;
    return {
      target,
      label: HEALTH_TARGET_LABELS[target],
      title: HEALTH_TARGET_TITLES[target],
      state,
      stateText: HEALTH_STATE_TEXT[state],
      summary: `${HEALTH_TARGET_TITLES[target]}: ${HEALTH_STATE_TEXT[state]}`,
      detail: detail === null || detail.length === 0 ? null : detail,
    };
  });
}

/**
 * Only the targets that are actually an outage.
 *
 * `not-provisioned` is a dormant target and `unknown` is a probe that has not
 * come back yet — the contract says so in as many words — so neither belongs in
 * a surface whose whole job is to interrupt. This is what lets a screen too
 * narrow for a permanent status row (a phone's contact list) show health only
 * when health is the news.
 */
export function kernelHealthOutages(
  views: ReadonlyArray<KernelHealthTargetView>,
): ReadonlyArray<KernelHealthTargetView> {
  return views.filter((view) => view.state === "down");
}
