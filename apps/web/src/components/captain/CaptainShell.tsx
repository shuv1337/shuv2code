import type { BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, PanelRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { ContactRail } from "./ContactRail";
import type { ContactRailFilter } from "./contactRail.logic";
import {
  CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
  CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
  CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX,
  CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
  CAPTAIN_RIGHT_RAIL_WIDTH_PX,
  CAPTAIN_RIGHT_RAIL_WIDTH_STORAGE_KEY,
  CAPTAIN_THREE_RAIL_MEDIA_QUERY,
  type CaptainLayoutMode,
  captainGridTemplateColumns,
  captainLeftRailWidth,
  captainOverlayRailWidth,
  captainRightRailMaxWidth,
  resolveCaptainLayoutModeFromMediaMatches,
  resolveCaptainShellRegions,
  shouldRenderConversationHeader,
} from "./captainShell.logic";

/**
 * The captain messenger shell (MESSENGER-PIVOT §2). One route-level shell owns
 * the three regions — contacts rail, conversation, bot side panel — replacing
 * the per-page `SidebarInset` that each `fleet/*` page used to render for
 * itself. It is the only place in the captain surface that knows about
 * geometry; every child is handed a region and renders inside it.
 *
 * Breakpoints are captain-owned (`captainShell.logic.ts`) and deliberately not
 * `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY`, which workspace mode shares.
 *
 * ## Mount points for later tickets
 * - `children` is the conversation region. Today it is `BotChatPage`, mounted
 *   unchanged (§5 step 1). M4 swaps it for `BubbleTimeline` + `CaptainComposer`
 *   behind the per-session toggle without touching this file.
 * - `rightRail` is the bot side panel region. M6 supplies `BotScreenPanel` +
 *   `RoutinesPanel`; until then the prop is absent and the region — and its
 *   header toggle — do not render at all, rather than reserving 470px of
 *   nothing.
 * - `conversationHeaderActions` is where M2's identity gear and inline rename
 *   mount, so the conversation header does not have to be re-cut for them.
 */
export function CaptainShell({
  activeBotId,
  children,
  conversationHeaderActions,
  rightRail,
  railFilter,
  onRailFilterChange,
}: {
  /** Null at the `/fleet` index, set at `/fleet/$botId`. */
  readonly activeBotId: BotId | null;
  readonly children: ReactNode;
  readonly conversationHeaderActions?: ReactNode;
  readonly rightRail?: ReactNode;
  /**
   * The rail's `?filter=` view, owned by the route that has the search params
   * (M3). Passing both halves down rather than reading the URL in the rail
   * keeps the rail a pure view of the roster, and keeps `/fleet/$botId` — which
   * has no filter of its own — from having to invent one.
   */
  readonly railFilter?: ContactRailFilter;
  readonly onRailFilterChange?: (next: ContactRailFilter) => void;
}) {
  const mode = useCaptainLayoutMode();
  const leftRailCollapsed = useUiStateStore((state) => state.captainLeftRailCollapsed);
  const rightRailCollapsed = useUiStateStore((state) => state.captainRightRailCollapsed);
  const setCaptainRailCollapsed = useUiStateStore((state) => state.setCaptainRailCollapsed);

  const regions = resolveCaptainShellRegions({
    mode,
    leftRailCollapsed,
    rightRailCollapsed,
    hasConversation: activeBotId !== null,
  });

  const hasRightRail = rightRail !== undefined && rightRail !== null;
  const rightRailInline = hasRightRail && regions.rightRailInline;

  /*
   * Rail width (§2: "470px, collapsible, resizable via `useResizableWidth`").
   *
   * The viewport clamp is handed to the hook rather than applied to its output.
   * Clamping the returned width here would leave the hook dragging from the
   * *stored* number while the panel rendered the clamped one — a dead zone at
   * the start of every drag on a narrower screen, then a jump. Inside the hook
   * there is one number: what is rendered, what a drag starts from, and what
   * gets persisted.
   */
  const viewportWidth = useViewportWidth();
  const leftRailWidth = captainLeftRailWidth(regions);
  const clampRightRailWidth = useCallback(
    (value: number) => Math.min(value, captainRightRailMaxWidth({ viewportWidth, leftRailWidth })),
    [leftRailWidth, viewportWidth],
  );
  const { width: inlineRightRailWidth, handlers: rightRailResizeHandlers } = useResizableWidth({
    storageKey: CAPTAIN_RIGHT_RAIL_WIDTH_STORAGE_KEY,
    defaultWidth: CAPTAIN_RIGHT_RAIL_WIDTH_PX,
    minWidth: CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
    maxWidth: CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX,
    edge: "left",
    clampWidth: clampRightRailWidth,
  });
  // The overlay floats over the conversation instead of sharing the grid with
  // it, so it does not pay the centre column's reservation (D1).
  const overlayRightRailWidth = captainOverlayRailWidth(viewportWidth);

  /**
   * The overlay's openness is *ephemeral*, not the persisted collapse flag.
   * Those are different questions: the flag says whether the captain wants the
   * panel docked when there is room to dock it, and an overlay that inherited
   * it would slide over the conversation unbidden the moment the window
   * narrowed. An overlay opens because someone asked for it, and it starts
   * closed every time.
   */
  const [overlayOpen, setOverlayOpen] = useState(false);
  const rightRailToggleRef = useRef<HTMLButtonElement | null>(null);
  const rightRailOverlayOpen = hasRightRail && !regions.rightRailInline && overlayOpen;

  // Leaving overlay territory (or losing the rail entirely) must not leave a
  // latched "open" behind to spring back on the next resize.
  useEffect(() => {
    if (!hasRightRail || regions.rightRailInline) {
      setOverlayOpen(false);
    }
  }, [hasRightRail, regions.rightRailInline]);

  const closeRightRailOverlay = useCallback(() => {
    setOverlayOpen(false);
    // Focus came from the toggle; it goes back there rather than to the top of
    // the document, which is where a dismissed overlay usually strands it.
    rightRailToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!rightRailOverlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRightRailOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeRightRailOverlay, rightRailOverlayOpen]);

  const toggleLeftRail = useCallback(() => {
    setCaptainRailCollapsed("left", !leftRailCollapsed);
  }, [leftRailCollapsed, setCaptainRailCollapsed]);

  const toggleRightRail = useCallback(() => {
    if (mode === "three-rails") {
      // Only here is there room to dock, so only here does the toggle mean
      // "dock/undock" — and that choice is the one worth persisting.
      setCaptainRailCollapsed("right", !rightRailCollapsed);
      return;
    }
    setOverlayOpen((open) => !open);
  }, [mode, rightRailCollapsed, setCaptainRailCollapsed]);

  const rightRailShown = rightRailInline || rightRailOverlayOpen;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="relative grid h-full min-h-0 w-full"
        style={{
          gridTemplateColumns: captainGridTemplateColumns(
            { ...regions, rightRailInline },
            inlineRightRailWidth,
          ),
        }}
      >
        {regions.leftRail === "hidden" ? null : (
          <ContactRail
            activeBotId={activeBotId}
            onToggleCollapsed={toggleLeftRail}
            regions={regions}
            {...(railFilter === undefined ? {} : { filter: railFilter })}
            {...(onRailFilterChange === undefined ? {} : { onFilterChange: onRailFilterChange })}
          />
        )}

        {regions.showCenter ? (
          <div className="flex min-h-0 min-w-0 flex-col">
            {shouldRenderConversationHeader({
              regions,
              hasActions: conversationHeaderActions !== undefined,
              hasRightRail,
            }) ? (
              <ConversationHeader
                actions={conversationHeaderActions}
                /*
                 * The app sidebar's own collapse trigger is `fixed` at z-50
                 * over the top-left corner. When the left rail is hidden this
                 * header is what sits under it, so it takes the same titlebar
                 * inset every other full-page surface uses. (When the rail is
                 * visible the rail's own header takes it instead.)
                 */
                insetForTitlebar={regions.leftRail === "hidden"}
                onToggleRightRail={toggleRightRail}
                rightRailShown={rightRailShown}
                rightRailToggleRef={rightRailToggleRef}
                showBackChevron={regions.showBackChevron}
                showRightRailToggle={hasRightRail && regions.showRightRailToggle}
              />
            ) : null}
            {/*
             * `BotChatPage` still renders its own `h-dvh` `SidebarInset` (§5
             * step 1 mounts it unchanged). Inside a shell region that is a
             * full viewport too tall, so the region neutralises it here rather
             * than editing the page we promised not to touch.
             */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col [&>[data-slot=sidebar-inset]]:h-full [&>[data-slot=sidebar-inset]]:min-h-0">
              {children}
            </div>
          </div>
        ) : null}

        {rightRailInline ? (
          <aside
            aria-label="Bot panel"
            /*
             * The aside itself does not scroll — the inner div does. The resize
             * handle is `absolute inset-y-0` against this element, so if the
             * scroll lived here the handle would scroll with the content and a
             * captain reading down the routine list would find nothing to grab
             * (D3). Positioning against the non-scrolling box keeps the full
             * height grabbable at any scroll position.
             */
            className="relative flex h-full min-h-0 flex-col overflow-hidden border-s border-border bg-sidebar"
          >
            <RightPanelResizeHandle handlers={rightRailResizeHandlers} />
            <div className="min-h-0 flex-1 overflow-y-auto">{rightRail}</div>
          </aside>
        ) : null}

        {rightRailOverlayOpen ? (
          <>
            <button
              aria-label="Close bot panel"
              className="absolute inset-0 z-10 bg-black/30"
              onClick={closeRightRailOverlay}
              type="button"
            />
            <aside
              aria-label="Bot panel"
              className={cn(
                "absolute inset-y-0 end-0 z-20 flex min-h-0 flex-col overflow-hidden border-s border-border bg-sidebar shadow-xl",
                regions.rightRail === "sheet" ? "w-full" : undefined,
              )}
              /*
               * No handle here: the overlay floats over the conversation rather
               * than sharing the grid with it, so there is no second column for
               * a drag to trade against — and at `sheet` it is the whole
               * viewport anyway. It renders at the design width capped by the
               * viewport, never at the inline width, which is reduced by a
               * centre-column reservation this layout does not have (D1).
               */
              style={
                regions.rightRail === "sheet" ? undefined : { width: `${overlayRightRailWidth}px` }
              }
            >
              <div className="min-h-0 flex-1 overflow-y-auto">{rightRail}</div>
            </aside>
          </>
        ) : null}
      </div>
    </SidebarInset>
  );
}

/**
 * The conversation region's own strip: back chevron when the list is gone,
 * M2's identity controls in the middle, right-rail toggle at the end. It always
 * renders, because it is also what clears the app's fixed sidebar trigger.
 */
/**
 * The conversation region's sticky header (§2).
 *
 * Exported for tests: it is the only mount point for the identity controls, so
 * "the actions actually render inside it" is a claim worth asserting against
 * real markup rather than inferring from the predicate that gates it.
 */
export function ConversationHeader({
  actions,
  insetForTitlebar,
  onToggleRightRail,
  rightRailShown,
  rightRailToggleRef,
  showBackChevron,
  showRightRailToggle,
}: {
  readonly actions: ReactNode;
  readonly insetForTitlebar: boolean;
  readonly onToggleRightRail: () => void;
  readonly rightRailShown: boolean;
  readonly rightRailToggleRef: React.RefObject<HTMLButtonElement | null>;
  readonly showBackChevron: boolean;
  readonly showRightRailToggle: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border px-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
        isElectron && "drag-region",
        insetForTitlebar && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {showBackChevron ? (
          <Button
            aria-label="Back to contacts"
            render={<Link to="/fleet" />}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
        ) : null}
        {actions}
      </span>
      {showRightRailToggle ? (
        <Button
          aria-label={rightRailShown ? "Hide bot panel" : "Show bot panel"}
          aria-pressed={rightRailShown}
          className="wco:me-[var(--workspace-native-controls-inset)]"
          onClick={onToggleRightRail}
          ref={rightRailToggleRef}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightIcon />
        </Button>
      ) : null}
    </header>
  );
}

/**
 * The viewport width, for clamping the resized rail.
 *
 * Deliberately not a media query: the clamp is a continuous function of width,
 * not a band, and the bands are already resolved above. `Infinity` when there
 * is no window is the same "unmeasurable resolves to the reference layout"
 * rule the band resolver uses — `captainRightRailMaxWidth` reads a non-finite
 * width as "no constraint".
 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * The active band, read from the same media queries the logic module defines
 * so a band cannot drift between the tested function and the DOM.
 */
function useCaptainLayoutMode(): CaptainLayoutMode {
  const threeRails = useMediaQuery(CAPTAIN_THREE_RAIL_MEDIA_QUERY);
  const rightOverlay = useMediaQuery(CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY);
  const iconLeftRail = useMediaQuery(CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY);
  return resolveCaptainLayoutModeFromMediaMatches({
    hasMediaSupport: typeof window !== "undefined" && typeof window.matchMedia === "function",
    threeRails,
    rightOverlay,
    iconLeftRail,
  });
}
