import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, ScopedThreadRef } from "@shuv2code/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { deriveTimelineEntries, deriveWorkLogEntries, deriveTurnPlans } from "../../session-logic";
import type { EnvironmentThread } from "@shuv2code/client-runtime/state/models";
import { cn } from "../../lib/utils";
import { useTheme } from "../../hooks/useTheme";
import {
  computeStableMessagesTimelineRows,
  resolveTimelineIsAtEnd,
  TIMELINE_CONTENT_MAX_WIDTH,
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "../chat/MessagesTimeline.logic";
import { AssignmentResultCard } from "../fleet/AssignmentResultCard";
import { AttributionLine } from "./AttributionLine";
import { BotAvatar } from "./BotAvatar";
import { DayDivider } from "./DayDivider";
import { JumpToLatestPill } from "./JumpToLatestPill";
import { MessageBubble } from "./MessageBubble";
import { TraceCard } from "./TraceCard";
import type { CaptainRowHostDisplayState } from "./CaptainRowHost";
import { buildBubbleTimelineItems, type BubbleTimelineItem } from "./bubbleTimeline.logic";
import type { BotAvatarView } from "./contactRail.logic";

/**
 * The captain messenger's conversation surface (MESSENGER-PIVOT §3).
 *
 * It consumes the *same* rows the IDE timeline consumes —
 * `deriveMessagesTimelineRows` / `computeStableMessagesTimelineRows` over
 * `deriveTimelineEntries` — and projects them into messenger items with
 * `buildBubbleTimelineItems`. `ChatView` is not mounted, and no captain
 * conditional was added to it: the only thing shared with the IDE renderer is
 * the row model and the one exported `TimelineRowHost`.
 *
 * ## Deliberate non-reuse
 * `timelineScrollAnchoring`'s `getAnchoredTurnMetrics` is ChatView's, and stays
 * ChatView's: it exists to anchor a new turn under a variable-height composer
 * overlay with a draft-hero transition. The messenger has a fixed slim composer
 * dock and no anchored end space, so it reuses the *end* half of that
 * machinery — `resolveTimelineIsAtEnd` and LegendList's `maintainScrollAtEnd` —
 * and nothing else. Borrowing the anchoring maths here would mean maintaining a
 * second caller for measurements this layout never takes.
 */
export function BubbleTimeline({
  thread,
  environmentId,
  threadRef,
  isWorking = false,
  botAvatar,
  botNameById,
  avatarByBotId,
  className,
}: {
  readonly thread: EnvironmentThread | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly isWorking?: boolean;
  /** The conversation's own bot, drawn beside its bubbles. */
  readonly botAvatar: BotAvatarView | null;
  /** Roster projection used to name folded sub-agent traffic. */
  readonly botNameById?: ReadonlyMap<string, string> | undefined;
  readonly avatarByBotId?: ReadonlyMap<string, BotAvatarView> | undefined;
  readonly className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  const stableRowsRef = useRef<StableMessagesTimelineRowsState>({ byId: new Map(), result: [] });
  const [isAtEnd, setIsAtEnd] = useState(true);
  // Disclosure state lives here, not in `MessagesTimeline`: the messenger owns
  // its own expansion because a TraceCard is the disclosure.
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());

  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  const turnPlans = useMemo(() => deriveTurnPlans(activities), [activities]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        thread?.messages ?? EMPTY_MESSAGES,
        thread?.proposedPlans ?? EMPTY_PLANS,
        workLogEntries,
        turnPlans,
      ),
    [thread?.messages, thread?.proposedPlans, turnPlans, workLogEntries],
  );

  const rows = useMemo(() => {
    const raw = deriveMessagesTimelineRows({
      timelineEntries,
      latestTurn: thread?.latestTurn ?? null,
      runningTurnId: thread?.latestTurn?.state === "running" ? thread.latestTurn.turnId : null,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt: thread?.latestTurn?.startedAt ?? null,
      turnDiffSummaryByAssistantMessageId: EMPTY_DIFF_SUMMARIES,
      revertTurnCountByUserMessageId: EMPTY_REVERT_COUNTS,
    });
    const next = computeStableMessagesTimelineRows(raw, stableRowsRef.current);
    stableRowsRef.current = next;
    return next.result;
  }, [expandedTurnIds, expandedWorkGroupIds, isWorking, thread?.latestTurn, timelineEntries]);

  const items = useMemo(() => buildBubbleTimelineItems({ rows, botNameById }), [botNameById, rows]);

  const onToggleTurnFold = useCallback((foldId: string) => {
    setExpandedTurnIds((previous) => toggleMembership(previous, foldId));
  }, []);
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroupIds((previous) => toggleMembership(previous, groupId));
  }, []);

  const display = useMemo<CaptainRowHostDisplayState>(
    () => ({
      timestampFormat: "locale",
      routeThreadKey: `${environmentId}:${threadRef.threadId}`,
      threadRef,
      activeThreadEnvironmentId: environmentId,
      resolvedTheme,
      markdownCwd: undefined,
      workspaceRoot: undefined,
      onToggleTurnFold,
      onToggleWorkGroup,
    }),
    [environmentId, onToggleTurnFold, onToggleWorkGroup, resolvedTheme, threadRef],
  );

  const handleScroll = useCallback(() => {
    const atEnd = resolveTimelineIsAtEnd(listRef.current?.getState?.());
    if (atEnd !== undefined) {
      setIsAtEnd(atEnd);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    void listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: BubbleTimelineItem }) => (
      <div
        className="mx-auto w-full min-w-0 overflow-x-clip"
        style={{ maxWidth: TIMELINE_CONTENT_MAX_WIDTH }}
      >
        <BubbleTimelineItemView
          avatarByBotId={avatarByBotId}
          botAvatar={botAvatar}
          display={display}
          item={item}
          threadRef={threadRef}
        />
      </div>
    ),
    [avatarByBotId, botAvatar, display, threadRef],
  );

  if (items.length === 0 && !isWorking) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p className="text-placeholder text-sm">No messages yet. Say hello.</p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full min-h-0", className)}>
      <LegendList<BubbleTimelineItem>
        className="h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5"
        data={items}
        estimatedItemSize={64}
        getItemType={getItemType}
        initialScrollAtEnd
        keyExtractor={keyExtractor}
        maintainScrollAtEnd={isAtEnd}
        onScroll={handleScroll}
        ref={listRef}
        renderItem={renderItem}
      />
      <JumpToLatestPill onJump={jumpToLatest} visible={!isAtEnd} />
    </div>
  );
}

function BubbleTimelineItemView({
  item,
  display,
  botAvatar,
  avatarByBotId,
  threadRef,
}: {
  readonly item: BubbleTimelineItem;
  readonly display: CaptainRowHostDisplayState;
  readonly botAvatar: BotAvatarView | null;
  readonly avatarByBotId?: ReadonlyMap<string, BotAvatarView> | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  switch (item.kind) {
    case "day-divider":
      return <DayDivider at={item.at} />;
    case "bubble":
      return (
        <MessageBubble
          author={item.author}
          avatar={botAvatar}
          createdAt={item.row.createdAt}
          groupPosition={item.groupPosition}
          markdownCwd={undefined}
          showAvatar={item.showAvatar}
          showCopyButton={item.author === "bot" && item.row.showAssistantCopyButton}
          streaming={item.row.assistantCopyStreaming}
          text={item.row.message.text ?? ""}
          threadRef={threadRef}
        />
      );
    case "assignment-result":
      return (
        <div className="flex w-full justify-start py-1">
          <div className="min-w-0 max-w-[min(90%,38rem)] rounded-2xl border border-border/60 bg-muted/30 px-3 py-2">
            <AssignmentResultCard delivery={item.delivery} variant="nested" />
          </div>
        </div>
      );
    case "attribution":
      return <AttributionLine avatarByBotId={avatarByBotId} item={item} />;
    case "working":
      return (
        <div className="flex items-center gap-2 py-2 pl-1 text-xs text-muted-foreground">
          {botAvatar === null ? null : <BotAvatar avatar={botAvatar} size="sm" />}
          <span className="animate-pulse">typing…</span>
        </div>
      );
    case "trace":
      return <TraceCard display={display} row={item.row} />;
    default:
      return null;
  }
}

function toggleMembership(previous: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

function keyExtractor(item: BubbleTimelineItem) {
  return item.id;
}

function getItemType(item: BubbleTimelineItem) {
  return item.kind === "bubble" ? `bubble:${item.author}` : item.kind;
}

const EMPTY_ACTIVITIES: EnvironmentThread["activities"] = [];
const EMPTY_MESSAGES: EnvironmentThread["messages"] = [];
const EMPTY_PLANS: EnvironmentThread["proposedPlans"] = [];
const EMPTY_DIFF_SUMMARIES: Parameters<
  typeof deriveMessagesTimelineRows
>[0]["turnDiffSummaryByAssistantMessageId"] = new Map();
const EMPTY_REVERT_COUNTS: Parameters<
  typeof deriveMessagesTimelineRows
>[0]["revertTurnCountByUserMessageId"] = new Map();
