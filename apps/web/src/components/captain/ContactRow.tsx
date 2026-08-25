import { Link } from "@tanstack/react-router";
import { AnchorIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar } from "./BotAvatar";
import { unreadBadgeLabel, type ContactRowView } from "./contactRail.logic";

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
                aria-label={collapsedRowLabel(row)}
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
              {/*
                A 64px strip has no room for a line, but it is exactly where a
                captain most needs to know something is waiting — the strip is
                what a narrow window collapses the rail *into*, so hiding the
                signal there would hide it at the width that has least room to
                go looking for it.
              */}
              {row.unreadCount > 0 || row.attentionLine !== null ? (
                <UnreadPip attention={row.attentionLine !== null} />
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="right">{collapsedRowLabel(row)}</TooltipPopup>
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
            {/*
              The time is pushed to the far right and never truncates. It is
              the one field whose whole value is its position: a messenger row
              is scanned down the right edge for "when", and a "5m ago" that
              wraps or clips has stopped being scannable.
            */}
            {row.timeLabel === null || row.timeIso === null ? null : (
              <time
                className="ms-auto shrink-0 text-[11px] tabular-nums text-sidebar-muted-foreground"
                dateTime={row.timeIso}
              >
                {row.timeLabel}
              </time>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {/*
              §2: an attention row *swaps* the preview for the amber line
              rather than stacking both. A 64px row has one dim line, and
              spending it on what a bot said while an approval is blocking work
              buries the only thing on the row the captain can act on.
            */}
            {row.attentionLine === null ? (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  row.unreadCount > 0
                    ? "font-medium text-sidebar-foreground"
                    : "text-sidebar-muted-foreground",
                )}
              >
                {row.secondaryLine}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-amber-600 dark:text-amber-400">
                {row.attentionLine}
              </span>
            )}
            {row.unreadCount > 0 && row.unreadLabel !== null ? (
              <span
                aria-label={row.unreadLabel}
                className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
                role="status"
              >
                {unreadBadgeLabel(row.unreadCount)}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Everything the collapsed strip cannot draw, said instead.
 *
 * At 64px the row is an avatar and a dot; the tooltip and the accessible name
 * are the only places the rest of the row's state exists, so they carry it
 * rather than repeating just the name.
 */
function collapsedRowLabel(row: ContactRowView): string {
  return [
    row.name,
    row.attentionLine ?? row.presenceLabel,
    row.attentionLine === null ? row.unreadLabel : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" — ");
}

/**
 * The collapsed strip's one bit of state. Amber for "waiting on you", primary
 * for "unread" — the same two colours the expanded row uses, so a captain who
 * narrows the window is not learning a second vocabulary.
 */
function UnreadPip({ attention }: { readonly attention: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 rounded-full border-2 border-sidebar",
        "absolute end-0 top-0",
        attention ? "bg-amber-500" : "bg-primary",
      )}
    />
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
