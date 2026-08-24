import { useLocation, useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useCallback } from "react";

import { useAdeNeedsYouCount } from "../../state/ade";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { getFleetEntryView } from "./SidebarFleetEntry.logic";

/**
 * Fleet nav row plus the "Needs You" badge (spec §7.8, UI slice 8). Lives in
 * the shared sidebar chrome so both the current and the legacy sidebar get it.
 * The count is polled by its query atom — there is no stream for it — and the
 * badge disappears entirely when nothing is waiting.
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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={view.isActive} onClick={handleClick} tooltip="Fleet">
          <UsersIcon />
          <span>Fleet</span>
          {view.badgeLabel === null ? null : (
            <Badge
              aria-label={view.badgeAriaLabel ?? undefined}
              className="ml-auto rounded-full px-1.5"
              size="sm"
              variant="destructive"
            >
              {view.badgeLabel}
            </Badge>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
