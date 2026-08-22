import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from "@shuv2code/contracts";
import { parseScopedThreadKey } from "@shuv2code/client-runtime/environment";
import type { AgentPanelModel } from "@shuv2code/client-runtime/state/subagentRuntime";
import { emptyAgentPanelModel } from "@shuv2code/client-runtime/state/subagentRuntime";
const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();
const NOOP_OPEN_AGENTS = () => {};
import { resolveChatListAnchoredEndSpace } from "@shuv2code/shared/chatList";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import {
  deriveTimelineEntries,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { stringifyToolDataForDisplay, type ToolResultImage } from "../../toolResultImages";
import { type TurnDiffSummary } from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  HammerIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  MinusIcon,
  SquarePenIcon,
  SquareIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
  Volume2Icon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { shouldAutoExpandChangedFiles } from "./changedFilesPresentation";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  shouldPreserveAssistantLineBreaks,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@shuv2code/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { useSpeechPlayback } from "../../textToSpeech/useSpeechPlayback";
import type { SpeechPlaybackState } from "../../textToSpeech/SpeechPlaybackController";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (foldId: string) => void;
  onToggleWorkGroup: (groupId: string, anchorKey?: string) => void;
  agentPanelModel: AgentPanelModel;
  onOpenAgents: () => void;
  speechPlaybackState: SpeechPlaybackState;
  onToggleAssistantSpeech: (messageId: MessageId, text: string) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  latestTurnId: TurnId | null;
  /** Current plan step label for the working row, when the turn has a plan. */
  workingStepLabel: string | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = <div className="h-10 sm:h-12" />;

// Header row shown when older turns exist beyond the loaded window. Plain
// button, no spinner animation; the label change is the loading indicator.
function TimelineLoadEarlierHeader({
  loading,
  onLoadEarlier,
  fade,
}: {
  loading: boolean;
  onLoadEarlier: () => void;
  fade: boolean;
}) {
  return (
    <div className={fade ? "pt-10 sm:pt-12" : "pt-3 sm:pt-4"}>
      <div className="mx-auto w-full max-w-3xl pb-2">
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={loading}
          className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
        >
          {loading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      </div>
    </div>
  );
}
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    itemLayout: true,
    layout: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  isWorking: boolean;
  workingStepLabel?: string | null;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  contentInsetEndAdjustment: number;
  /**
   * Whether the timeline should keep pinning to the live edge as content
   * grows. Off while the user is reading history; LegendList's own
   * maintainScrollAtEnd would otherwise re-pin regardless of ChatView's
   * scroll-mode refs whenever the user drifts near the bottom.
   */
  liveFollowEnabled: boolean;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: () => void;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  workingStepLabel = null,
  activeTurnInProgress,
  activeTurnStartedAt,
  agentPanelModel = EMPTY_AGENT_PANEL_MODEL,
  onOpenAgents = NOOP_OPEN_AGENTS,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId,
  onAnchorReady,
  contentInsetEndAdjustment,
  liveFollowEnabled,
  onIsAtEndChange,
  onManualNavigation,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  loadEarlier = null,
}: MessagesTimelineProps) {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const {
    state: speechPlaybackState,
    toggle: toggleAssistantSpeech,
    stop: stopAssistantSpeech,
  } = useSpeechPlayback();

  useEffect(() => {
    stopAssistantSpeech();
  }, [routeThreadKey, stopAssistantSpeech]);

  const onToggleAssistantSpeech = useCallback(
    (messageId: MessageId, text: string) => {
      void toggleAssistantSpeech(messageId, text);
    },
    [toggleAssistantSpeech],
  );

  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onToggleTurnFold = useCallback(
    (foldId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${foldId}`);
      setExpandedTurnIds((existing) => {
        const next = new Set(existing);
        if (next.has(foldId)) {
          next.delete(foldId);
        } else {
          next.add(foldId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey?: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey ?? groupId);
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === "message" ? row.message.id : null,
    );
    return config ? { ...config, onReady: handleAnchorReady } : undefined;
  }, [anchorMessageId, handleAnchorReady, rows]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state, contentInsetEndAdjustment);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [contentInsetEndAdjustment, listRef, minimapItems, minimapStripMap, onIsAtEndChange]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth));
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      agentPanelModel,
      onOpenAgents,
      speechPlaybackState,
      onToggleAssistantSpeech,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      agentPanelModel,
      onOpenAgents,
      speechPlaybackState,
      onToggleAssistantSpeech,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
      latestTurnId: latestTurn?.turnId ?? null,
      workingStepLabel,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking, latestTurn?.turnId, workingStepLabel],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      return null;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            maintainScrollAtEnd={
              anchoredEndSpace || !liveFollowEnabled || disclosureToggleSettling
                ? false
                : TIMELINE_MAINTAIN_SCROLL_AT_END
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            onScroll={handleScroll}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            ListHeaderComponent={
              loadEarlier !== null ? (
                <TimelineLoadEarlierHeader
                  loading={loadEarlier.loading}
                  onLoadEarlier={loadEarlier.onLoadEarlier}
                  fade={topFadeEnabled}
                />
              ) : topFadeEnabled ? (
                TIMELINE_LIST_FADE_HEADER
              ) : (
                TIMELINE_LIST_HEADER
              )
            }
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          <TimelineMinimap
            items={minimapItems}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  items,
  stripMap,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            event.preventDefault();
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{ top }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle" ||
          row.kind === "turn-plan"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "turn-plan" ? <TurnPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userAttachments = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayedUserMessage.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  const elementContexts = [
    ...displayedUserMessage.elementContexts,
    ...elementContextState.contexts,
  ];
  const previewImages = userAttachments.filter(
    (attachment) =>
      attachment.type === "image" && attachment.name.startsWith("preview-annotation-"),
  );
  const regularImages = userAttachments.filter(
    (attachment) =>
      attachment.type === "image" && !attachment.name.startsWith("preview-annotation-"),
  );
  const regularFiles = userAttachments.filter((attachment) => attachment.type === "file");
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-secondary-label text-[11px]">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {regularFiles.length > 0 ? (
          <div className="mb-2 flex max-w-[420px] flex-col gap-1.5">
            {regularFiles.map((file) => {
              const content = (
                <>
                  <FileTextIcon className="size-5 shrink-0 text-red-500/80" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{file.name}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      PDF
                    </span>
                  </span>
                </>
              );
              return file.previewUrl ? (
                <a
                  key={file.id}
                  href={file.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2 hover:bg-background"
                  aria-label={`Open ${file.name}`}
                >
                  {content}
                </a>
              ) : (
                <div
                  key={file.id}
                  className="flex items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2"
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : null}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={elementContextState.promptText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.foldId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
      {!row.expanded ? <ToolResultImageGallery images={row.images} /> : null}
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(row.message.streaming)}
          lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
          skills={ctx.skills}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            <AssistantSpeechButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatDayAwareTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function AssistantSpeechButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const assistantSpeechState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });
  if (!assistantSpeechState.visible || assistantSpeechState.text === null) {
    return null;
  }

  const active =
    ctx.speechPlaybackState.messageId === row.message.id &&
    ctx.speechPlaybackState.status !== "idle";
  const loading = active && ctx.speechPlaybackState.status === "loading";
  const label = active ? "Stop reading message" : "Read message aloud";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="text-muted-foreground hover:text-foreground"
            onClick={() =>
              ctx.onToggleAssistantSpeech(row.message.id, assistantSpeechState.text ?? "")
            }
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {loading ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : active ? (
          <SquareIcon className="size-3 fill-current" />
        ) : (
          <Volume2Icon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

/**
 * Inline folded plan chip: one row per turn that produced plan/todo steps.
 * Collapsed by default — a segment bar plus the in-progress step label —
 * and expands in place to the full step list. Replaces the old plan sidebar.
 */
const TurnPlanTimelineRow = memo(function TurnPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "turn-plan" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { steps } = row.turnPlan.plan;
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const allDone = completedCount === steps.length;
  // Label priority: the in-progress step, else the next pending step (plan
  // just created), else the last step (plan finished, rendered muted).
  const label =
    steps.find((step) => step.status === "inProgress")?.step ??
    steps.find((step) => step.status === "pending")?.step ??
    steps.at(-1)?.step ??
    "Plan";
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="min-w-0 px-1 py-0.5">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
        {steps.length > 1 ? (
          <span aria-hidden className="flex shrink-0 items-center gap-0.5">
            {steps.map((step) => (
              <span
                key={step.step}
                className={cn(
                  "h-[3px] w-2.5 rounded-full",
                  step.status === "completed"
                    ? "bg-success"
                    : step.status === "inProgress"
                      ? "bg-primary"
                      : "bg-muted-foreground/25",
                )}
              />
            ))}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate",
            allDone ? "text-muted-foreground/65" : "font-medium text-foreground/85",
          )}
        >
          {label}
        </span>
        {steps.length > 1 ? (
          <span className="shrink-0 text-muted-foreground/50 tabular-nums">
            {completedCount}/{steps.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="mt-0.5 space-y-px pl-6">
          {steps.map((step) => (
            <div key={step.step} className="flex items-baseline gap-2 text-[12px] leading-5">
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[10px]",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "text-primary"
                      : "text-muted-foreground/40",
                )}
                aria-hidden
              >
                {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  step.status === "completed"
                    ? "text-muted-foreground/55"
                    : step.status === "inProgress"
                      ? "text-foreground/90"
                      : "text-muted-foreground/70",
                )}
              >
                {step.step}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { workingStepLabel } = use(TimelineRowActivityCtx);
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-secondary-label text-[11px] tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span className="shrink-0">
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
        {workingStepLabel ? (
          <span className="min-w-0 truncate text-muted-foreground/55">· {workingStepLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "Work Log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-secondary-label text-[11px]">{groupLabel}</p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : row.hiddenCount === 1
      ? "log entry"
      : "log entries";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-icon-muted">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const activity = use(TimelineRowActivityCtx);
  const isLatestTurn = activity.latestTurnId === turnSummary.turnId;
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const [autoExpanded] = useState(() =>
    shouldAutoExpandChangedFiles(checkpointFiles, isLatestTurn),
  );
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(autoExpanded);
  const expanded = persistedExpanded ?? (isLatestTurn && autoExpanded);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      expanded={expanded}
      showCompactPreview={isLatestTurn}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onExpandedChange={(nextExpanded) =>
        setExpanded(routeThreadKey, turnSummary.turnId, nextExpanded)
      }
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-foreground/85 text-xs">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-foreground text-xs font-medium">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-secondary-label text-[10px]",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-secondary-label text-xs hover:bg-muted/55 hover:text-message-foreground"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-message-foreground"
            lineBreaks
            parseRawHtml={false}
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-message-foreground text-sm leading-relaxed">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-message-foreground"
                  lineBreaks
                  parseRawHtml={false}
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-message-foreground text-sm leading-relaxed">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-message-foreground"
          lineBreaks
          parseRawHtml={false}
        />,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-message-foreground text-sm leading-relaxed">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-message-foreground"
      lineBreaks
      parseRawHtml={false}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-message-foreground text-xs font-medium">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-secondary-label text-[11px]">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-message-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-icon-muted",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles" | "toolInput">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  const inputPreview = toolInputPreview(workEntry.toolInput);
  if (inputPreview) return inputPreview;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function toolInputPreview(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") return input.trim() || null;
  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "code", "path", "query", "url", "prompt", "name"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/\s+/g, " ").trim();
      }
    }
  }
  const formatted = stringifyToolDataForDisplay(input).replace(/\s+/g, " ").trim();
  return formatted || null;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${stringifyToolDataForDisplay(workEntry.toolData)}`);
  }
  if (workEntry.toolInput !== undefined && workEntry.command === undefined) {
    blocks.push(`Input\n${stringifyToolDataForDisplay(workEntry.toolInput)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";
  if (workEntry.requestKind === "thread-control") return "wrench";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

type ToolResultPreviewImage = {
  readonly id: string;
  readonly name: string;
  readonly src: string;
};

function ToolResultImageButton(props: {
  image: ToolResultImage;
  src: string;
  previewImages: ReadonlyArray<ToolResultPreviewImage>;
}) {
  const ctx = use(TimelineRowCtx);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === props.src;
  if (failed) {
    return (
      <div
        role="status"
        className="flex min-h-24 items-center justify-center rounded-lg border border-destructive/30 bg-background/70 px-3 text-center text-xs text-destructive"
      >
        Unable to display {props.image.name}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="group/image relative block min-h-24 w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/70 bg-background/70"
      aria-label={`Expand ${props.image.name}`}
      onClick={(event) => {
        event.stopPropagation();
        const index = props.previewImages.findIndex((image) => image.id === props.image.id);
        if (index < 0) return;
        ctx.onImageExpand({
          images: props.previewImages.map(({ name, src }) => ({ name, src })),
          index,
        });
      }}
      onPointerDown={stopRowToggle}
    >
      <img
        src={props.src}
        alt={props.image.name}
        loading="lazy"
        draggable={false}
        onError={() => setFailedSrc(props.src)}
        className="block max-h-80 w-full object-contain transition-transform duration-200 group-hover/image:scale-[1.01]"
      />
    </button>
  );
}

function WorkspaceToolResultImage(props: {
  image: ToolResultImage;
  threadRef: ScopedThreadRef;
  previewImages: ReadonlyArray<ToolResultPreviewImage>;
}) {
  const assetUrl = useAssetUrlState(props.threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.image.workspacePath!,
  });
  if (assetUrl._tag === "Loading") {
    return (
      <div
        role="status"
        className="flex min-h-24 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-xs text-muted-foreground"
      >
        <LoaderCircleIcon className="mr-2 size-3.5 animate-spin" />
        Loading image…
      </div>
    );
  }
  if (assetUrl._tag === "Failure") {
    return (
      <div
        role="alert"
        className="flex min-h-24 items-center justify-center rounded-lg border border-destructive/30 bg-background/70 px-3 text-center text-xs text-destructive"
      >
        Unable to load {props.image.name}
      </div>
    );
  }
  const previewImages = props.previewImages.some((image) => image.id === props.image.id)
    ? props.previewImages
    : [...props.previewImages, { id: props.image.id, name: props.image.name, src: assetUrl.url }];
  return (
    <ToolResultImageButton image={props.image} src={assetUrl.url} previewImages={previewImages} />
  );
}

function ToolResultImageGallery(props: { images: ReadonlyArray<ToolResultImage> }) {
  const ctx = use(TimelineRowCtx);
  const threadRef = ctx.threadRef;
  const workspaceImages = useMemo(
    () =>
      props.images.filter(
        (image): image is ToolResultImage & { readonly workspacePath: string } =>
          image.previewUrl === undefined &&
          typeof image.workspacePath === "string" &&
          image.workspacePath.length > 0,
      ),
    [props.images],
  );
  const workspaceResources = useMemo(
    () =>
      threadRef
        ? workspaceImages.map((image) => ({
            _tag: "workspace-file" as const,
            threadId: threadRef.threadId,
            path: image.workspacePath,
          }))
        : [],
    [threadRef, workspaceImages],
  );
  const workspaceUrls = useAssetUrls(ctx.activeThreadEnvironmentId, workspaceResources);
  const previewImages = useMemo(() => {
    const resolvedById = new Map<string, ToolResultPreviewImage>();
    for (const image of props.images) {
      if (image.previewUrl) {
        resolvedById.set(image.id, {
          id: image.id,
          name: image.name,
          src: image.previewUrl,
        });
      }
    }
    workspaceImages.forEach((image, index) => {
      const src = workspaceUrls[index];
      if (!src) return;
      resolvedById.set(image.id, { id: image.id, name: image.name, src });
    });
    return props.images.flatMap((image) => {
      const resolved = resolvedById.get(image.id);
      return resolved ? [resolved] : [];
    });
  }, [props.images, workspaceImages, workspaceUrls]);

  if (props.images.length === 0) return null;
  return (
    <div
      className={cn(
        "mt-1.5 ms-7 grid max-w-2xl gap-2",
        props.images.length > 1 ? "grid-cols-2" : "grid-cols-1",
      )}
      data-tool-result-images={props.images.length}
      onClick={stopRowToggle}
      onPointerDown={stopRowToggle}
    >
      {props.images.map((image) =>
        image.previewUrl ? (
          <ToolResultImageButton
            key={image.id}
            image={image}
            src={image.previewUrl}
            previewImages={previewImages}
          />
        ) : image.workspacePath && threadRef ? (
          <WorkspaceToolResultImage
            key={image.id}
            image={image}
            threadRef={threadRef}
            previewImages={previewImages}
          />
        ) : (
          <div
            key={image.id}
            role="status"
            className="flex min-h-24 items-center justify-center rounded-lg border border-border/70 bg-background/70 px-3 text-center text-xs text-muted-foreground"
          >
            {image.error ?? image.name}
          </div>
        ),
      )}
    </div>
  );
}

const AgentSpawnCtaRow = memo(function AgentSpawnCtaRow(props: { workEntry: TimelineWorkEntry }) {
  const { agentPanelModel, onOpenAgents } = use(TimelineRowCtx);
  const agentCount = props.workEntry.agentSpawn?.agentTaskIds.length ?? 0;
  const running = agentPanelModel.directAgents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  return (
    <button
      type="button"
      onClick={onOpenAgents}
      className="-mx-1 flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", running > 0 ? "bg-info" : "bg-success")}
      />
      <span className="min-w-0 truncate font-medium">
        Kicked off {agentCount} subagent{agentCount === 1 ? "" : "s"}
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">Open Agents</span>
    </button>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  // Before any hooks: spawn CTA rows render their own component.
  if (workEntry.agentSpawn) {
    return <AgentSpawnCtaRow workEntry={workEntry} />;
  }
  if (workEntry.sourceActivityKind === "reasoning.completed" && workEntry.detail?.trim()) {
    return <ReasoningWorkEntryRow workEntry={workEntry} />;
  }
  return <PlainWorkEntryRow workEntry={workEntry} workspaceRoot={workspaceRoot} />;
});

const ReasoningWorkEntryRow = memo(function ReasoningWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
}) {
  const detail = props.workEntry.detail?.trim();
  const [expanded, setExpanded] = useState(true);
  if (!detail) return null;

  return (
    <div className="rounded-md px-0.5 py-0.5" data-reasoning-summary-visible={expanded}>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-[12px] leading-5 transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse thinking" : "Expand thinking"}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-foreground">
          <BotIcon className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 font-medium text-foreground">Thinking</span>
        <span className="flex size-4 shrink-0 items-center justify-center text-icon-muted">
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 opacity-70 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </button>
      {expanded ? (
        <pre className="ms-7 cursor-text whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text">
          {detail}
        </pre>
      ) : null}
    </div>
  );
});

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-icon-muted"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-expanded": expanded,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-secondary-label">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-icon-muted">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      <ToolResultImageGallery images={workEntry.images ?? []} />
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  );
});
