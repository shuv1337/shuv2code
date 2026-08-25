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

/**
 * Resize bounds for the right rail (§2: "470px, collapsible, resizable").
 *
 * The minimum is not cosmetic. Below it the screen thumbnail stops being a
 * picture of anything and the routine rows lose their schedule line, which is
 * a rail that occupies space without answering a question. The maximum leaves
 * the centre column its `CAPTAIN_CENTER_MIN_WIDTH_PX` at the reference width,
 * so dragging the handle can never squeeze the conversation out of the layout
 * it was sized for.
 */
export const CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX = 320;
export const CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX = 720;
/** localStorage key for the persisted rail width. */
export const CAPTAIN_RIGHT_RAIL_WIDTH_STORAGE_KEY = "shuv2code:captain-right-rail-width";

/**
 * How much viewport the overlay leaves uncovered, so the conversation behind it
 * is still visibly there and the scrim is still hittable.
 */
export const CAPTAIN_RIGHT_RAIL_OVERLAY_MARGIN_PX = 48;

/**
 * The widest the **inline** rail may be drawn at this viewport, so the centre
 * column keeps its minimum. Pure, and separated from the hook because the
 * failure it prevents — a rail persisted at 720px reopening on a 1440px window
 * and pushing the conversation under 520px — only shows up at a width nobody
 * resized at.
 *
 * Inline-only is load-bearing. This subtracts `CAPTAIN_CENTER_MIN_WIDTH_PX`
 * because an inline rail *shares* the grid with the conversation and has to
 * leave room for it. An overlay does not share anything: it floats over the
 * conversation, so charging it the same reservation is arithmetic about a
 * layout it is not in — at 1280px it collapsed a 470px panel to the 320px
 * minimum for no reason a captain could see. Overlays use
 * `captainOverlayRailWidth` instead.
 */
export function captainRightRailMaxWidth(input: {
  readonly viewportWidth: number;
  readonly leftRailWidth: number;
}): number {
  if (!Number.isFinite(input.viewportWidth)) return CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX;
  const available = input.viewportWidth - input.leftRailWidth - CAPTAIN_CENTER_MIN_WIDTH_PX;
  return Math.max(
    CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
    Math.min(CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX, available),
  );
}

/**
 * The width of the rail when it is floating over the conversation rather than
 * docked beside it (§2: 1180–1439 opens a 470px overlay).
 *
 * The design width, capped only by the viewport it has to fit inside. There is
 * no resize handle in overlay mode — nothing to trade width against — so the
 * dragged width deliberately does not apply here; the overlay is the same panel
 * at the size the design specifies, every time it opens.
 */
export function captainOverlayRailWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return CAPTAIN_RIGHT_RAIL_WIDTH_PX;
  return Math.max(
    CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
    Math.min(CAPTAIN_RIGHT_RAIL_WIDTH_PX, viewportWidth - CAPTAIN_RIGHT_RAIL_OVERLAY_MARGIN_PX),
  );
}

/** The grid width the left rail actually occupies in a given region set. */
export function captainLeftRailWidth(regions: CaptainShellRegions): number {
  switch (regions.leftRail) {
    case "expanded":
      return CAPTAIN_LEFT_RAIL_WIDTH_PX;
    case "icon":
      return CAPTAIN_LEFT_RAIL_ICON_WIDTH_PX;
    case "hidden":
      return 0;
  }
}

/**
 * Captain-owned media queries. Each is a bare **lower** bound and the bands are
 * resolved widest-first, so the four together cover the real line with no gap
 * and no overlap.
 *
 * A previous cut paired each `min-width` with a `max-width: n - 1px` upper
 * bound. That leaves an uncovered sliver — a viewport of 899.5px (ordinary on a
 * fractional-DPR display or at browser zoom) matched *no* query, fell through
 * to the default, and rendered the three-rail layout clipped inside 900px. A
 * band boundary must be a single number, named once.
 */
export const CAPTAIN_THREE_RAIL_MEDIA_QUERY = `(min-width: ${CAPTAIN_THREE_RAIL_MIN_WIDTH}px)`;
export const CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY = `(min-width: ${CAPTAIN_RIGHT_OVERLAY_MIN_WIDTH}px)`;
export const CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY = `(min-width: ${CAPTAIN_ICON_LEFT_RAIL_MIN_WIDTH}px)`;

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

/**
 * The same band decision, made from `matchMedia` results instead of a number.
 * Widest-first: every width satisfies the lower bounds of its own band and all
 * narrower ones, so the first match wins and nothing can fall between bands.
 *
 * `hasMediaSupport: false` means nobody could measure anything (no
 * `matchMedia` at all — SSR, a bare test renderer). That resolves to the
 * reference layout, matching `resolveCaptainLayoutMode`'s rule for an
 * unmeasurable width: guessing "phone" on a desktop is the expensive mistake.
 */
export function resolveCaptainLayoutModeFromMediaMatches(matches: {
  readonly hasMediaSupport: boolean;
  readonly threeRails: boolean;
  readonly rightOverlay: boolean;
  readonly iconLeftRail: boolean;
}): CaptainLayoutMode {
  if (!matches.hasMediaSupport) {
    return "three-rails";
  }
  if (matches.threeRails) {
    return "three-rails";
  }
  if (matches.rightOverlay) {
    return "right-overlay";
  }
  if (matches.iconLeftRail) {
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
export function captainGridTemplateColumns(
  regions: CaptainShellRegions,
  /** The resized rail width; the 470px default when nobody has dragged it. */
  rightRailWidthPx: number = CAPTAIN_RIGHT_RAIL_WIDTH_PX,
): string {
  if (regions.mode === "single-column") {
    // Whichever column the route chose is full-bleed. A fixed 380px rail on a
    // 375px phone is a horizontal scrollbar, not a layout.
    return "minmax(0, 1fr)";
  }
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
    tracks.push(`${rightRailWidthPx}px`);
  }
  return tracks.length === 0 ? "minmax(0, 1fr)" : tracks.join(" ");
}

/**
 * Whether the conversation region renders its header at all.
 *
 * Extracted from the JSX and tested across every band because of the failure
 * it guards: the header is the *only* mount point for the identity controls
 * (§2 — sticky 56px header with avatar, name, gear), so any band where it is
 * skipped is a band where `conversationHeaderActions` is handed to the shell
 * and silently goes nowhere. That is invisible in a component test of the
 * actions and invisible in a logic test of the regions; it only shows up when
 * someone opens the app at a width nobody checked.
 *
 * Supplied actions alone are therefore enough to render it. The header is not
 * decoration that earns its place by having a chevron or a rail toggle to
 * show — it is where the captain renames a bot.
 */
export function shouldRenderConversationHeader(input: {
  readonly regions: CaptainShellRegions;
  readonly hasActions: boolean;
  readonly hasRightRail: boolean;
}): boolean {
  if (!input.regions.showCenter) {
    return false;
  }
  return (
    input.hasActions ||
    input.regions.showBackChevron ||
    (input.hasRightRail && input.regions.showRightRailToggle)
  );
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
