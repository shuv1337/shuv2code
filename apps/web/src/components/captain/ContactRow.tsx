import { Link } from "@tanstack/react-router";
import { AnchorIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar } from "./BotAvatar";
import type { ContactRowView } from "./contactRail.logic";

/**
 * One contact in the rail (§2: 64px, avatar, name, role chip, dim one-line).
 * The whole row is the link — a messenger contact has one destination, so a
 * separate "Chat" button would be a second control for the same intent. The
 * lazy-session wording (`chatLabel`) survives as the row's title attribute so
 * "Resume chat" versus "Chat" is still reachable without a button.
 */
export function ContactRow({
  row,
  isActive,
  collapsed,
}: {
  readonly row: ContactRowView;
  readonly isActive: boolean;
  readonly collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <li>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                aria-current={isActive ? "page" : undefined}
                aria-label={`${row.name} — ${row.presenceLabel}`}
                className={cn(
                  "flex h-12 items-center justify-center rounded-lg outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
                  isActive && "bg-sidebar-row-hover",
                )}
                params={{ botId: row.botId }}
                to="/fleet/$botId"
              />
            }
          >
            <span className="relative flex">
              <BotAvatar avatar={row.avatar} size="md" />
              <PresenceDot isOnline={row.isOnline} />
            </span>
          </TooltipTrigger>
          <TooltipPopup side="right">
            {row.name} — {row.presenceLabel}
          </TooltipPopup>
        </Tooltip>
      </li>
    );
  }

  return (
    <li>
      <Link
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex h-16 items-center gap-3 rounded-lg px-2 outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
          isActive && "bg-sidebar-row-hover",
        )}
        params={{ botId: row.botId }}
        title={row.chatLabel}
        to="/fleet/$botId"
      >
        <span className="relative flex shrink-0">
          <BotAvatar avatar={row.avatar} size="lg" />
          <PresenceDot isOnline={row.isOnline} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {row.isFirstmate ? (
              <AnchorIcon
                aria-label="Firstmate"
                className="size-3.5 shrink-0 text-sidebar-muted-foreground"
              />
            ) : null}
            <span className="truncate text-sm font-medium">{row.name}</span>
            <Badge className="shrink-0" size="sm" variant="secondary">
              {row.roleTag}
            </Badge>
          </span>
          <span className="truncate text-xs text-sidebar-muted-foreground">
            {row.secondaryLine}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Warm-session presence. A hollow ring rather than nothing for an idle bot, so
 * "no session" reads as a state the row is reporting rather than as a dot that
 * failed to render. Labelled by the row, not by itself.
 */
function PresenceDot({ isOnline }: { readonly isOnline: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 rounded-full border-2 border-sidebar",
        "absolute end-0 bottom-0",
        isOnline ? "bg-emerald-500" : "bg-sidebar-muted-foreground/40",
      )}
    />
  );
}
