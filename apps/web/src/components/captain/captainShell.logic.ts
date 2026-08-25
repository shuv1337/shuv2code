/**
 * Pure geometry for the captain messenger shell (MESSENGER-PIVOT §2, M1).
 *
 * The shell owns its own breakpoints. It deliberately does **not** reuse
 * `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY` (`(max-width: 980px)`), which is
 * shared with workspace mode: the messenger's promise is three rails inline at
 * the reference width, and borrowing the workspace's single threshold is what
 * hid the third rail at common laptop widths.
 *
 * Everything here is a function of (viewport width, persisted collapse
 * preference, whether a conversation is routed). No DOM, no store, no React —
 * so every band is testable without a browser.
 */

/** All three rails sit inline from here up. Non-negotiable per §2. */
export const CAPTAIN_THREE_RAIL_MIN_WIDTH = 1440;
/** Below this the right rail stops being inline and becomes an overlay. */
export const CAPTAIN_RIGHT_OVERLAY_MIN_WIDTH = 1180;
/** Below this the left rail is forced to its 64px avatar strip. */
export const CAPTAIN_ICON_LEFT_RAIL_MIN_WIDTH = 900;

export const CAPTAIN_LEFT_RAIL_WIDTH_PX = 380;
export const CAPTAIN_LEFT_RAIL_ICON_WIDTH_PX = 64;
export const CAPTAIN_RIGHT_RAIL_WIDTH_PX = 470;
export const CAPTAIN_CENTER_MIN_WIDTH_PX = 520;

/** Captain-owned media queries, mirroring the bands below exactly. */
export const CAPTAIN_THREE_RAIL_MEDIA_QUERY = `(min-width: ${CAPTAIN_THREE_RAIL_MIN_WIDTH}px)`;
export const CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY = `(min-width: ${CAPTAIN_RIGHT_OVERLAY_MIN_WIDTH}px) and (max-width: ${CAPTAIN_THREE_RAIL_MIN_WIDTH - 1}px)`;
export const CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY = `(min-width: ${CAPTAIN_ICON_LEFT_RAIL_MIN_WIDTH}px) and (max-width: ${CAPTAIN_RIGHT_OVERLAY_MIN_WIDTH - 1}px)`;
export const CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY = `(max-width: ${CAPTAIN_ICON_LEFT_RAIL_MIN_WIDTH - 1}px)`;

export type CaptainLayoutMode =
  /** ≥1440: contacts, conversation, bot panel, all inline. */
  | "three-rails"
  /** 1180–1439: right rail becomes a header toggle + scrim overlay. */
  | "right-overlay"
  /** 900–1179: left rail forced to the 64px icon strip. */
  | "icon-left-rail"
  /** <900: one column at a time, chosen by the route. */
  | "single-column";

export type CaptainLeftRailMode = "expanded" | "icon" | "hidden";
export type CaptainRightRailMode = "inline" | "overlay" | "sheet";

export interface CaptainShellRegions {
  readonly mode: CaptainLayoutMode;
  readonly leftRail: CaptainLeftRailMode;
  /** False only in single-column mode sitting at the index route. */
  readonly showCenter: boolean;
  readonly rightRail: CaptainRightRailMode;
  /** True when the right rail is currently occupying grid space. */
  readonly rightRailInline: boolean;
  /** Group headers degrade to dividers once the rail is an icon strip. */
  readonly showGroupHeaders: boolean;
  /** The conversation needs a way back to the list when the list is gone. */
  readonly showBackChevron: boolean;
  /** Whether the header renders the right-rail toggle at all. */
  readonly showRightRailToggle: boolean;
}

export function resolveCaptainLayoutMode(viewportWidth: number): CaptainLayoutMode {
  if (!Number.isFinite(viewportWidth) || viewportWidth >= CAPTAIN_THREE_RAIL_MIN_WIDTH) {
    // A width we cannot measure (SSR, jsdom, a detached window) resolves to the
    // reference layout rather than to the most degraded one: guessing "phone"
    // on a desktop is the expensive mistake.
    return "three-rails";
  }
  if (viewportWidth >= CAPTAIN_RIGHT_OVERLAY_MIN_WIDTH) {
    return "right-overlay";
  }
  if (viewportWidth >= CAPTAIN_ICON_LEFT_RAIL_MIN_WIDTH) {
    return "icon-left-rail";
  }
  return "single-column";
}

export interface CaptainShellRegionsInput {
  readonly mode: CaptainLayoutMode;
  /** The persisted preference, not the resolved state. */
  readonly leftRailCollapsed: boolean;
  readonly rightRailCollapsed: boolean;
  /** True at `/fleet/$botId`; false at the `/fleet` index. */
  readonly hasConversation: boolean;
}

export function resolveCaptainShellRegions(input: CaptainShellRegionsInput): CaptainShellRegions {
  const { mode, leftRailCollapsed, rightRailCollapsed, hasConversation } = input;

  if (mode === "single-column") {
    // Route-driven: the URL, not a toggle, decides which single column shows.
    return {
      mode,
      leftRail: hasConversation ? "hidden" : "expanded",
      showCenter: hasConversation,
      rightRail: "sheet",
      rightRailInline: false,
      showGroupHeaders: true,
      showBackChevron: hasConversation,
      showRightRailToggle: hasConversation,
    };
  }

  // Below the three-rail width the icon strip is forced, so a captain who
  // expanded the rail on a wide screen does not get a 380px rail on a 1000px
  // one — but the preference survives untouched for when they widen again.
  const leftRail: CaptainLeftRailMode =
    mode === "icon-left-rail" || leftRailCollapsed ? "icon" : "expanded";

  const rightRail: CaptainRightRailMode =
    mode === "three-rails" && !rightRailCollapsed ? "inline" : "overlay";

  return {
    mode,
    leftRail,
    showCenter: true,
    rightRail,
    rightRailInline: rightRail === "inline",
    showGroupHeaders: leftRail === "expanded",
    showBackChevron: false,
    showRightRailToggle: true,
  };
}

/**
 * The grid track list for the shell's three regions. The center keeps a real
 * minimum only where there is room for one; below the reference width a hard
 * 520px min would force a horizontal scrollbar instead of a narrower column.
 */
export function captainGridTemplateColumns(regions: CaptainShellRegions): string {
  const tracks: string[] = [];
  if (regions.leftRail === "expanded") {
    tracks.push(`${CAPTAIN_LEFT_RAIL_WIDTH_PX}px`);
  } else if (regions.leftRail === "icon") {
    tracks.push(`${CAPTAIN_LEFT_RAIL_ICON_WIDTH_PX}px`);
  }
  if (regions.showCenter) {
    tracks.push(
      regions.mode === "three-rails"
        ? `minmax(${CAPTAIN_CENTER_MIN_WIDTH_PX}px, 1fr)`
        : "minmax(0, 1fr)",
    );
  }
  if (regions.rightRailInline) {
    tracks.push(`${CAPTAIN_RIGHT_RAIL_WIDTH_PX}px`);
  }
  return tracks.length === 0 ? "minmax(0, 1fr)" : tracks.join(" ");
}

/** Label for the left-rail collapse control, phrased as the action it performs. */
export function captainLeftRailToggleLabel(regions: CaptainShellRegions): string {
  return regions.leftRail === "expanded" ? "Collapse contacts" : "Expand contacts";
}

/**
 * Whether toggling the left rail is even offered. At 900–1179 the icon strip is
 * imposed by width, so a control that claims to expand it would lie.
 */
export function canToggleCaptainLeftRail(mode: CaptainLayoutMode): boolean {
  return mode === "three-rails" || mode === "right-overlay";
}
