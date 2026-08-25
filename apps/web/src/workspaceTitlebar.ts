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

/** Leftmost header on a rail-only frame: start past the traffic lights. */
export const RAIL_TITLEBAR_INSET_CLASS =
  "[[data-rail-titlebar-inset]_&]:pl-[var(--workspace-controls-left)]";

/**
 * The same clearance for a strip too narrow to give it up horizontally (the
 * 64px icon rail is narrower than the lights are wide), so its content drops
 * below the titlebar band instead.
 */
export const RAIL_TITLEBAR_TOP_INSET_CLASS =
  "[[data-rail-titlebar-inset]_&]:pt-[var(--workspace-topbar-height)]";
