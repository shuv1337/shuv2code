/**
 * How a kernel health state becomes pixels on a phone.
 *
 * The vocabulary — order, labels, the sentence a state turns into, and which
 * states are an outage rather than dormancy — is
 * `@shuv2code/client-runtime/ade/kernel-health`, shared with the web sidebar
 * pills. Only the paint is here, because web's classes are for a browser
 * stylesheet and Uniwind resolves a different set.
 */
import {
  getKernelHealthTargetViews,
  kernelHealthOutages,
  type KernelHealthTargetView,
} from "@shuv2code/client-runtime/ade/kernel-health";
import type { FleetHealthSnapshot, HealthState } from "@shuv2code/contracts";

/**
 * Spelled out rather than interpolated, for the same reason the avatar tints
 * are: Uniwind only emits class names it can find as literals, so a computed
 * `bg-${…}` compiles to a dot with no colour. The `Record<HealthState, …>`
 * annotation is what makes adding a state to the contract fail to typecheck
 * here instead of rendering an invisible pill.
 */
const STATE_DOT_CLASS: Record<HealthState, string> = {
  healthy: "bg-emerald-500",
  down: "bg-red-500",
  "not-provisioned": "bg-foreground-tertiary",
  unknown: "bg-foreground-tertiary",
};

export interface KernelHealthPillView extends KernelHealthTargetView {
  readonly dotClassName: string;
  /** Everything a screen reader should hear from one dot and one word. */
  readonly accessibilityLabel: string;
}

function pillView(view: KernelHealthTargetView): KernelHealthPillView {
  return {
    ...view,
    dotClassName: STATE_DOT_CLASS[view.state],
    accessibilityLabel: view.detail === null ? view.summary : `${view.summary}. ${view.detail}`,
  };
}

/** Every monitored target, for a surface with room to show all of them. */
export function getKernelHealthPillViews(
  snapshot: FleetHealthSnapshot | null,
): ReadonlyArray<KernelHealthPillView> {
  return getKernelHealthTargetViews(snapshot).map(pillView);
}

/**
 * Only the targets that are an outage, for the contact list.
 *
 * A phone's fleet list has no room for a permanent three-pill status row, and
 * a row that is present-but-green on every launch teaches the captain to stop
 * reading it — so health appears there exactly when health is the news. The
 * full row still lives one tap away on a bot's profile, which is where a
 * captain goes when they already suspect something.
 */
export function getKernelHealthAlertViews(
  snapshot: FleetHealthSnapshot | null,
): ReadonlyArray<KernelHealthPillView> {
  return kernelHealthOutages(getKernelHealthTargetViews(snapshot)).map(pillView);
}

/**
 * The one line the fleet list shows when something is down.
 *
 * Named targets rather than a count: "1 kernel is down" makes the captain open
 * something to find out which, and the whole point of interrupting them here is
 * that they should not have to.
 */
export function kernelHealthAlertLine(views: ReadonlyArray<KernelHealthPillView>): string | null {
  if (views.length === 0) return null;
  const names = views.map((view) => view.title);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return names.length === 1 ? `${list} is down` : `${list} are down`;
}
