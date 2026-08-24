/**
 * Pure view mapping for the sidebar Fleet entry (spec §7.8, UI slice 8): the
 * nav row itself plus the "Needs You" badge beside it.
 */
import type { AdeNeedsYouCount } from "@shuv2code/contracts";

export interface FleetEntryView {
  /** Highlighted while the reader is anywhere under `/fleet`. */
  readonly isActive: boolean;
  /** Absent when nothing is waiting — a badge reading "0" is noise. */
  readonly badgeLabel: string | null;
  readonly badgeAriaLabel: string | null;
}

/** Past this the badge stops counting and starts gesturing. */
const NEEDS_YOU_BADGE_CAP = 99;

export function isFleetPath(pathname: string): boolean {
  return pathname === "/fleet" || pathname.startsWith("/fleet/");
}

/**
 * The badge text. A count that has not arrived yet, or one that arrived as
 * zero, renders nothing at all rather than a placeholder: the badge only ever
 * says that something is waiting.
 */
export function needsYouBadgeLabel(count: AdeNeedsYouCount | null): string | null {
  if (count === null || count.open <= 0) {
    return null;
  }
  return count.open > NEEDS_YOU_BADGE_CAP ? `${NEEDS_YOU_BADGE_CAP}+` : String(count.open);
}

export function getFleetEntryView(input: {
  readonly pathname: string;
  readonly needsYouCount: AdeNeedsYouCount | null;
}): FleetEntryView {
  const badgeLabel = needsYouBadgeLabel(input.needsYouCount);
  return {
    isActive: isFleetPath(input.pathname),
    badgeLabel,
    badgeAriaLabel:
      badgeLabel === null
        ? null
        : input.needsYouCount?.open === 1
          ? "1 item needs you"
          : `${input.needsYouCount?.open ?? 0} items need you`,
  };
}
