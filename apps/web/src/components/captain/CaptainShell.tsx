import type { BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, PanelRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { ContactRail } from "./ContactRail";
import {
  CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
  CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
  CAPTAIN_RIGHT_RAIL_WIDTH_PX,
  CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY,
  CAPTAIN_THREE_RAIL_MEDIA_QUERY,
  type CaptainLayoutMode,
  captainGridTemplateColumns,
  resolveCaptainShellRegions,
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
 */
export function CaptainShell({
  activeBotId,
  children,
  rightRail,
}: {
  /** Null at the `/fleet` index, set at `/fleet/$botId`. */
  readonly activeBotId: BotId | null;
  readonly children: ReactNode;
  readonly rightRail?: ReactNode;
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

  const toggleLeftRail = useCallback(() => {
    setCaptainRailCollapsed("left", !leftRailCollapsed);
  }, [leftRailCollapsed, setCaptainRailCollapsed]);
  const toggleRightRail = useCallback(() => {
    setCaptainRailCollapsed("right", !rightRailCollapsed);
  }, [rightRailCollapsed, setCaptainRailCollapsed]);

  const hasRightRail = rightRail !== undefined && rightRail !== null;
  const rightRailInline = hasRightRail && regions.rightRailInline;
  const rightRailOverlayOpen = hasRightRail && !regions.rightRailInline && !rightRailCollapsed;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="relative grid h-full min-h-0 w-full"
        style={{
          gridTemplateColumns: captainGridTemplateColumns({ ...regions, rightRailInline }),
        }}
      >
        {regions.leftRail === "hidden" ? null : (
          <ContactRail
            activeBotId={activeBotId}
            onToggleCollapsed={toggleLeftRail}
            regions={regions}
          />
        )}

        {regions.showCenter ? (
          <div className="flex min-h-0 min-w-0 flex-col">
            {regions.showBackChevron || (hasRightRail && regions.showRightRailToggle) ? (
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
                {regions.showBackChevron ? (
                  <Button
                    aria-label="Back to contacts"
                    render={<Link to="/fleet" />}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronLeftIcon />
                  </Button>
                ) : (
                  <span />
                )}
                {hasRightRail && regions.showRightRailToggle ? (
                  <Button
                    aria-label={
                      rightRailInline || rightRailOverlayOpen ? "Hide bot panel" : "Show bot panel"
                    }
                    aria-pressed={rightRailInline || rightRailOverlayOpen}
                    onClick={toggleRightRail}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PanelRightIcon />
                  </Button>
                ) : null}
              </div>
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
            className="flex h-full min-h-0 flex-col border-s border-border bg-sidebar"
          >
            {rightRail}
          </aside>
        ) : null}

        {rightRailOverlayOpen ? (
          <>
            <button
              aria-label="Close bot panel"
              className="absolute inset-0 z-10 bg-black/30"
              onClick={toggleRightRail}
              type="button"
            />
            <aside
              aria-label="Bot panel"
              className={cn(
                "absolute inset-y-0 end-0 z-20 flex min-h-0 flex-col border-s border-border bg-sidebar shadow-xl",
                regions.rightRail === "sheet" ? "w-full" : undefined,
              )}
              style={
                regions.rightRail === "sheet"
                  ? undefined
                  : { width: `${CAPTAIN_RIGHT_RAIL_WIDTH_PX}px` }
              }
            >
              {rightRail}
            </aside>
          </>
        ) : null}
      </div>
    </SidebarInset>
  );
}

/**
 * The active band, read from the same media queries the logic module defines
 * so a band cannot drift between the tested function and the DOM.
 */
function useCaptainLayoutMode(): CaptainLayoutMode {
  const threeRails = useMediaQuery(CAPTAIN_THREE_RAIL_MEDIA_QUERY);
  const rightOverlay = useMediaQuery(CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY);
  const iconLeftRail = useMediaQuery(CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY);
  const singleColumn = useMediaQuery(CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY);
  if (singleColumn) return "single-column";
  if (iconLeftRail) return "icon-left-rail";
  if (rightOverlay) return "right-overlay";
  if (threeRails) return "three-rails";
  // No query matched, which means no `matchMedia` (SSR, a test renderer). The
  // logic module's rule applies: fall back to the reference layout, never to
  // the most degraded one.
  return "three-rails";
}
