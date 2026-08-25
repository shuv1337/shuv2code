import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, ScopedThreadRef } from "@shuv2code/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deriveTimelineEntries, deriveWorkLogEntries, deriveTurnPlans } from "../../session-logic";
import type { EnvironmentThread } from "@shuv2code/client-runtime/state/models";
import { cn } from "../../lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import {
  computeStableMessagesTimelineRows,
  resolveTimelineIsAtEnd,
  TIMELINE_CONTENT_MAX_WIDTH,
  deriveMessagesTimelineRows,
  type StableMessagesTimelineRowsState,
} from "../chat/MessagesTimeline.logic";
import { AssignmentResultCard } from "../fleet/AssignmentResultCard";
import { AttributionLine } from "./AttributionLine";
import { BotAvatar } from "./BotAvatar";
import { DayDivider } from "./DayDivider";
import { JumpToLatestPill } from "./JumpToLatestPill";
import { MessageBubble } from "./MessageBubble";
import { TraceCard } from "./TraceCard";
import type { CaptainRowHostActivity, CaptainRowHostDisplayState } from "./CaptainRowHost";
import {
  buildBubbleTimelineItems,
  resolveBubbleMessageDisplay,
  resolveBubbleTimelineActivity,
  resolveTurnFoldAnchorKey,
  shouldRestoreBubblePosition,
  type BubbleTimelineItem,
} from "./bubbleTimeline.logic";
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
 * ## Disclosure state lives here
 * Every expansion in the conversation — a `TraceCard`, an `AttributionLine`
 * fold, and the two IDE-owned disclosures (`turn-fold`, `work-toggle`) — is
 * held by this component, keyed by item id. `LegendList` unmounts rows that
 * leave the window, so a card that held its own `useState` would re-collapse
 * whenever the captain scrolled past it and back. `MessagesTimeline` hoists for
 * exactly this reason.
 *
 * ## Deliberate non-reuse
 * `timelineScrollAnchoring`'s `getAnchoredTurnMetrics` is ChatView's, and stays
 * ChatView's: it exists to anchor a new turn under a variable-height composer
 * overlay with a draft-hero transition. The messenger has a fixed slim composer
 * dock and no anchored end space, so it reuses the *end* half of that
 * machinery — `resolveTimelineIsAtEnd` and LegendList's `maintainScrollAtEnd` —
 * and nothing else. Borrowing the anchoring maths here would mean maintaining a
 * second caller for measurements this layout never takes.
 *
 * What it *does* borrow is `MessagesTimeline`'s disclosure handling: expanding a
 * row grows `itemLayout`, which `maintainScrollAtEnd` reads as "content grew,
 * follow it" and yanks the captain to the bottom. Suspending end-maintenance for
 * two frames while anchoring `maintainVisibleContentPosition` to the *toggled*
 * row keeps the thing the captain just opened where they opened it.
 */
export function BubbleTimeline({
  thread,
  environmentId,
  threadRef,
  isWorking = false,
  botAvatar,
  botNameById,
  avatarByBotId,
  onIsAtEndChange,
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
  /**
   * Reported upward because the read receipt needs it (M3 → M4 seam,
   * `useBotChatRead`): a captain scrolled up a long thread is reading history,
   * not clearing the tail. This timeline is the only thing that knows.
   */
  readonly onIsAtEndChange?: ((isAtEnd: boolean) => void) | undefined;
  readonly className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const listRef = useRef<LegendListRef | null>(null);
  const stableRowsRef = useRef<StableMessagesTimelineRowsState>({ byId: new Map(), result: [] });
  const [isAtEnd, setIsAtEnd] = useState(true);
  // Disclosure state lives here, not in `MessagesTimeline`: the messenger owns
  // its own expansion because a TraceCard is the disclosure.
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [expandedItemIds, setExpandedItemIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [disclosureSettling, setDisclosureSettling] = useState(false);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureFrameRef = useRef<number | null>(null);
  const disclosureSecondFrameRef = useRef<number | null>(null);

  // Switching contacts reuses this component. Row identity is per-thread, so
  // carrying either the disclosure sets or the stable-row cache across the
  // switch would apply one conversation's expansions to another's rows.
  const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;
  const previousThreadKeyRef = useRef(threadKey);
  if (previousThreadKeyRef.current !== threadKey) {
    previousThreadKeyRef.current = threadKey;
    stableRowsRef.current = { byId: new Map(), result: [] };
  }
  useEffect(() => {
    setExpandedTurnIds(EMPTY_IDS);
    setExpandedWorkGroupIds(EMPTY_IDS);
    setExpandedItemIds(EMPTY_IDS);
    setExpandedImage(null);
    setIsAtEnd(true);
    onIsAtEndChange?.(true);
  }, [onIsAtEndChange, threadKey]);

  useEffect(() => {
    return () => {
      if (disclosureFrameRef.current !== null) cancelAnimationFrame(disclosureFrameRef.current);
      if (disclosureSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSecondFrameRef.current);
      }
    };
  }, []);

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

  const latestTurn = thread?.latestTurn ?? null;
  const rows = useMemo(() => {
    const raw = deriveMessagesTimelineRows({
      timelineEntries,
      latestTurn,
      runningTurnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt: latestTurn?.startedAt ?? null,
      turnDiffSummaryByAssistantMessageId: EMPTY_DIFF_SUMMARIES,
      revertTurnCountByUserMessageId: EMPTY_REVERT_COUNTS,
    });
    const next = computeStableMessagesTimelineRows(raw, stableRowsRef.current);
    stableRowsRef.current = next;
    return next.result;
  }, [expandedTurnIds, expandedWorkGroupIds, isWorking, latestTurn, timelineEntries]);

  const items = useMemo(() => buildBubbleTimelineItems({ rows, botNameById }), [botNameById, rows]);

  /**
   * The activity context every expanded row reads. These are the fields that
   * decide whether a tool call renders as *running* or as *succeeded*, so they
   * are plumbed rather than assumed: `isWorking` and a live `latestTurnId` are
   * already in scope here.
   */
  const activity = useMemo<CaptainRowHostActivity>(
    () => resolveBubbleTimelineActivity({ isWorking, latestTurn }),
    [isWorking, latestTurn],
  );

  /**
   * Two frames of grace after a disclosure toggle: long enough for LegendList to
   * measure the grown row, short enough that a message arriving mid-toggle still
   * follows normally afterwards. Lifted from `MessagesTimeline`.
   */
  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureSettling(true);
    if (disclosureFrameRef.current !== null) cancelAnimationFrame(disclosureFrameRef.current);
    if (disclosureSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSecondFrameRef.current);
    }
    disclosureFrameRef.current = requestAnimationFrame(() => {
      disclosureSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureSettling(false);
        disclosureFrameRef.current = null;
        disclosureSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback(
    (item: BubbleTimelineItem) =>
      shouldRestoreBubblePosition(disclosureAnchorKeyRef.current, item.id),
    [],
  );

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  // `turn-fold` and `work-toggle` rows carry their own disclosure inside the
  // genuine IDE row, so their toggles arrive through the shared-state callbacks.
  // The anchor keys match the row ids `deriveMessagesTimelineRows` mints, which
  // are also the item ids the bubble projection emits for a trace.
  const onToggleTurnFold = useCallback(
    (foldId: string) => {
      suspendEndScrollMaintenanceForDisclosure(resolveTurnFoldAnchorKey(foldId));
      setExpandedTurnIds((previous) => toggleMembership(previous, foldId));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey?: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey ?? groupId);
      setExpandedWorkGroupIds((previous) => toggleMembership(previous, groupId));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleItem = useCallback(
    (itemId: string) => {
      suspendEndScrollMaintenanceForDisclosure(itemId);
      setExpandedItemIds((previous) => toggleMembership(previous, itemId));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onImageExpand = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const display = useMemo<CaptainRowHostDisplayState>(
    () => ({
      timestampFormat,
      routeThreadKey: `${environmentId}:${threadRef.threadId}`,
      threadRef,
      activeThreadEnvironmentId: environmentId,
      resolvedTheme,
      markdownCwd: undefined,
      workspaceRoot: undefined,
      onImageExpand,
      onToggleTurnFold,
      onToggleWorkGroup,
    }),
    [
      environmentId,
      onImageExpand,
      onToggleTurnFold,
      onToggleWorkGroup,
      resolvedTheme,
      threadRef,
      timestampFormat,
    ],
  );

  const handleScroll = useCallback(() => {
    const atEnd = resolveTimelineIsAtEnd(listRef.current?.getState?.());
    if (atEnd !== undefined) {
      setIsAtEnd(atEnd);
      onIsAtEndChange?.(atEnd);
    }
  }, [onIsAtEndChange]);

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
          activity={activity}
          avatarByBotId={avatarByBotId}
          botAvatar={botAvatar}
          display={display}
          expanded={expandedItemIds.has(item.id)}
          item={item}
          onImageExpand={onImageExpand}
          onToggle={onToggleItem}
          threadRef={threadRef}
        />
      </div>
    ),
    [
      activity,
      avatarByBotId,
      botAvatar,
      display,
      expandedItemIds,
      onImageExpand,
      onToggleItem,
      threadRef,
    ],
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
        maintainScrollAtEnd={isAtEnd && !disclosureSettling ? BUBBLE_MAINTAIN_SCROLL_AT_END : false}
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        onScroll={handleScroll}
        ref={listRef}
        // Explicit false: messenger rows hold their own disclosure state (a
        // TraceCard's expansion), and recycling would carry it onto whatever
        // row reuses the slot.
        recycleItems={false}
        renderItem={renderItem}
      />
      <JumpToLatestPill onJump={jumpToLatest} visible={!isAtEnd} />
      {expandedImage === null ? null : (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          onClose={closeExpandedImage}
          preview={expandedImage}
        />
      )}
    </div>
  );
}

function BubbleTimelineItemView({
  item,
  display,
  activity,
  botAvatar,
  avatarByBotId,
  threadRef,
  expanded,
  onToggle,
  onImageExpand,
}: {
  readonly item: BubbleTimelineItem;
  readonly display: CaptainRowHostDisplayState;
  readonly activity: CaptainRowHostActivity;
  readonly botAvatar: BotAvatarView | null;
  readonly avatarByBotId?: ReadonlyMap<string, BotAvatarView> | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly expanded: boolean;
  readonly onToggle: (itemId: string) => void;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  switch (item.kind) {
    case "day-divider":
      return <DayDivider at={item.at} />;
    case "bubble": {
      const messageDisplay = resolveBubbleMessageDisplay(item.row);
      if (!messageDisplay.hasContent) return null;
      return (
        <MessageBubble
          author={item.author}
          avatar={botAvatar}
          createdAt={item.row.createdAt}
          display={messageDisplay}
          groupPosition={item.groupPosition}
          markdownCwd={undefined}
          onImageExpand={onImageExpand}
          showAvatar={item.showAvatar}
          showCopyButton={item.author === "bot" && item.row.showAssistantCopyButton}
          streaming={item.row.assistantCopyStreaming}
          threadRef={threadRef}
        />
      );
    }
    case "assignment-result":
      return (
        <div className="flex w-full justify-start py-1">
          <div className="min-w-0 max-w-[min(90%,38rem)] rounded-2xl border border-border/60 bg-muted/30 px-3 py-2">
            <AssignmentResultCard delivery={item.delivery} variant="nested" />
          </div>
        </div>
      );
    case "attribution":
      return (
        <AttributionLine
          avatarByBotId={avatarByBotId}
          expanded={expanded}
          item={item}
          onToggle={() => onToggle(item.id)}
        />
      );
    case "working":
      return (
        <div className="flex items-center gap-2 py-2 pl-1 text-xs text-muted-foreground">
          {botAvatar === null ? null : <BotAvatar avatar={botAvatar} size="sm" />}
          <span className="animate-pulse">typing…</span>
        </div>
      );
    case "trace":
      return (
        <TraceCard
          activity={activity}
          display={display}
          expanded={expanded}
          onToggle={() => onToggle(item.id)}
          row={item.row}
        />
      );
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

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const BUBBLE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;
const EMPTY_ACTIVITIES: EnvironmentThread["activities"] = [];
const EMPTY_MESSAGES: EnvironmentThread["messages"] = [];
const EMPTY_PLANS: EnvironmentThread["proposedPlans"] = [];
const EMPTY_DIFF_SUMMARIES: Parameters<
  typeof deriveMessagesTimelineRows
>[0]["turnDiffSummaryByAssistantMessageId"] = new Map();
const EMPTY_REVERT_COUNTS: Parameters<
  typeof deriveMessagesTimelineRows
>[0]["revertTurnCountByUserMessageId"] = new Map();
