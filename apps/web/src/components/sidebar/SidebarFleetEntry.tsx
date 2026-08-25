import { useLocation, useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useCallback } from "react";

import { useAdeNeedsYouCount } from "../../state/ade";
import { Badge } from "../ui/badge";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { getFleetEntryView } from "./SidebarFleetEntry.logic";

/**
 * Fleet nav row plus the "Needs You" badge (spec §7.8, UI slice 8). Lives in
 * the shared sidebar chrome so both the current and the legacy sidebar get it.
 * The count is polled by its query atom — there is no stream for it — and the
 * badge disappears entirely when nothing is waiting.
 *
 * The badge is the inbox's entry point (spec §7 slice 5: badge, then list,
 * then detail), so it is its own control rather than decoration on the Fleet
 * row — a captain who sees a count wants what is behind it, not the roster. It
 * rides `SidebarMenuAction`, which renders as a sibling of the nav button,
 * because a button nested inside a button is not a thing.
 */
export function SidebarFleetEntry() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const needsYou = useAdeNeedsYouCount();
  const view = getFleetEntryView({ pathname, needsYouCount: needsYou.data });

  const handleClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/fleet" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBadgeClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/fleet/needs-you" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={view.isActive} onClick={handleClick} tooltip="Fleet">
          <UsersIcon />
          <span>Fleet</span>
        </SidebarMenuButton>
        {view.badgeLabel === null ? null : (
          <SidebarMenuAction
            aria-label={view.badgeAriaLabel ?? undefined}
            className="top-1.5 aspect-auto w-auto"
            onClick={handleBadgeClick}
          >
            <Badge className="rounded-full px-1.5" size="sm" variant="destructive">
              {view.badgeLabel}
            </Badge>
          </SidebarMenuAction>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
