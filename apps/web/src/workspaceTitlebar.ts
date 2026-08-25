export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]";

/**
 * How far in from the window edge the macOS traffic lights reach, so app chrome
 * can start to the right of them on a frameless desktop window.
 */
export const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

/**
 * The contract between a frame that has **no** app sidebar and whatever surface
 * is leftmost inside it (#216).
 *
 * The workspace inset above keys off `data-sidebar-state=collapsed`, which only
 * exists because `SidebarProvider` is in the tree. On the captain surface it is
 * not: the contacts rail is the leftmost surface, permanently, so it clears the
 * traffic lights unconditionally rather than only while some other panel is
 * collapsed. The frame publishes the attribute; the header that sits under the
 * lights opts in with one of these classes.
 *
 * There is no `--workspace-titlebar-content-left` here on purpose. That variable
 * budgets room for the app sidebar's fixed collapse trigger, and no such trigger
 * renders on a rail-only frame — content starts immediately past the lights.
 */
export const RAIL_TITLEBAR_INSET_ATTRIBUTE = "data-rail-titlebar-inset";

/**
 * How far from the window's left edge the header taking the inset begins.
 *
 * Set by any surface that is not itself at x=0 — the conversation region sits
 * to the right of the contacts rail, so the clearance it owes the lights is
 * what is left of them after the rail has already covered some. Unset means
 * "flush against the window edge", which is the rail's own header.
 */
export const RAIL_TITLEBAR_OFFSET_VARIABLE = "--rail-titlebar-offset";

/**
 * Start past the traffic lights, counting whatever is already to the left.
 *
 * The subtraction is what makes one rule serve every rail width. At the 64px
 * icon strip the conversation header begins 64px in, so a flat inset would
 * clear the lights twice and open a visible gutter; without any inset its first
 * control lands ~4px from the lights at browser zoom, which is the collision
 * this exists to prevent. `max()` floors it at zero for the 380px rail, where
 * the lights are covered by the rail entirely.
 */
export const RAIL_TITLEBAR_INSET_CLASS =
  "[[data-rail-titlebar-inset]_&]:pl-[max(0px,calc(var(--workspace-controls-left)-var(--rail-titlebar-offset,0px)))]";

/**
 * The same clearance for a strip too narrow to give it up horizontally (the
 * 64px icon rail is narrower than the lights are wide), so its content drops
 * below the titlebar band instead.
 */
export const RAIL_TITLEBAR_TOP_INSET_CLASS =
  "[[data-rail-titlebar-inset]_&]:pt-[var(--workspace-topbar-height)]";
