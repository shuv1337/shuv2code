import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { AssignmentResultCard } from "../fleet/AssignmentResultCard";
import { parseAssignmentDeliveryText } from "../fleet/assignmentResult.logic";
import { BotAvatar } from "./BotAvatar";
import type { BotAvatarView } from "./contactRail.logic";
import type { BubbleTimelineItem } from "./bubbleTimeline.logic";

/**
 * Folded sub-agent traffic (MESSENGER-PIVOT §3): "2 messages with Code Monkey".
 *
 * A bot delegating work produces a burst of synthetic assignment-delivery turns
 * that are the *machine's* conversation, not the captain's. Consecutive ones
 * collapse to this one line, which expands into the real
 * `AssignmentResultCard`s — the fold hides them, it never discards them.
 *
 * The bot names on the line are roster-resolved by `buildBubbleTimelineItems`;
 * this component only draws the result.
 *
 * Expansion is controlled by the timeline for the same reason `TraceCard`'s is:
 * `LegendList` unmounts off-window rows, so a fold the captain opened would
 * quietly close itself on the way back.
 */
export function AttributionLine({
  item,
  avatarByBotId,
  expanded,
  onToggle,
  className,
}: {
  readonly item: Extract<BubbleTimelineItem, { kind: "attribution" }>;
  readonly avatarByBotId?: ReadonlyMap<string, BotAvatarView> | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}) {
  const avatars = item.botIds
    .map((botId) => avatarByBotId?.get(botId))
    .filter((avatar): avatar is BotAvatarView => avatar !== undefined);

  return (
    <div className={cn("flex flex-col gap-2 py-1.5", className)} data-attribution-id={item.id}>
      <button
        aria-expanded={expanded}
        className="flex items-center gap-2 self-center rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={onToggle}
        type="button"
      >
        {avatars.length === 0 ? null : (
          <span aria-hidden className="flex -space-x-1.5">
            {avatars.slice(0, 3).map((avatar, index) => (
              <BotAvatar
                avatar={avatar}
                className="ring-1 ring-background"
                key={`${item.id}:${index}`}
                size="sm"
              />
            ))}
          </span>
        )}
        <span>{item.label}</span>
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2">
          {item.rows.map((row) => {
            const delivery = parseAssignmentDeliveryText(row.message.text ?? "");
            return delivery === null ? null : (
              <AssignmentResultCard delivery={delivery} key={row.id} variant="nested" />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
