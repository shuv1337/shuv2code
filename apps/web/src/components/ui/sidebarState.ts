export type ResponsiveSidebarState = "expanded" | "collapsed";

/**
 * Where the sidebar's collapse preference is persisted. `SidebarProvider` has
 * written this on every toggle since it was vendored; until #216 nothing ever
 * read it back, because the provider only ever unmounted with the document.
 *
 * The captain surface changed that: `/fleet` swaps the provider out of the tree
 * entirely (there is one left rail there, and it is not this one), so the
 * provider remounts on the way back and re-seeds `defaultOpen`. Without a read
 * the cookie is a write-only record of a preference that resets on every round
 * trip — a captain who collapsed the sidebar finds it open again after each
 * fleet visit.
 */
export const SIDEBAR_STATE_COOKIE_NAME = "sidebar_state";

/**
 * The persisted collapse preference, parsed from a `document.cookie` string.
 *
 * Open on anything unrecognised — an absent, malformed, or truncated cookie
 * means "no preference recorded", and the failure modes are not symmetric: a
 * sidebar that opens when it should not is a visible, one-click correction,
 * while a sidebar that stays shut on a first run is an app with no navigation
 * and no obvious way to get it back.
 */
export function resolveSidebarDefaultOpen(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) {
    return true;
  }
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() !== SIDEBAR_STATE_COOKIE_NAME) continue;
    // First match wins: browsers list the most specific path first, which is
    // the one the provider's own write targeted.
    return entry.slice(separator + 1).trim() !== "false";
  }
  return true;
}

export function resolveSidebarState(input: {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
}): ResponsiveSidebarState {
  return (input.isMobile ? input.openMobile : input.open) ? "expanded" : "collapsed";
}
