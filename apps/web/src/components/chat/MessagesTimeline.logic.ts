import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type TurnPlanEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@shuv2code/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      foldId: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
      images: NonNullable<WorkLogEntry["images"]>;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "turn-plan";
      id: string;
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const terminalCandidateByResponseKey = new Map<
    string,
    { readonly messageId: string; readonly voice: boolean }
  >();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    const voice = message.modality === "voice";
    const previous = terminalCandidateByResponseKey.get(responseKey);

    // Voice speech is supporting Call history. It can be projected after the
    // provider's durable answer, but must not replace that answer as the
    // terminal result merely because it arrived later. Prefer the last text
    // message when one exists, and fall back to the last voice message for a
    // voice-only response.
    if (!previous || !voice || previous.voice) {
      terminalCandidateByResponseKey.set(responseKey, { messageId: message.id, voice });
    }
  }

  return new Set(
    [...terminalCandidateByResponseKey.values()].map((candidate) => candidate.messageId),
  );
}

/**
 * A provider turn can contain several user steering messages. Keep the last
 * assistant message after each user boundary visible so the rendered chat
 * preserves those conversational exchanges even though the provider still
 * owns one durable turn underneath them.
 */
function deriveExchangeAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const turnIdsWithTextAssistant = new Set<TurnId>();
  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.modality !== "voice" &&
      entry.message.turnId
    ) {
      turnIdsWithTextAssistant.add(entry.message.turnId);
    }
  }

  const terminalCandidateByExchange = new Map<
    string,
    { readonly messageId: string; readonly voice: boolean }
  >();
  let exchangeIndex = 0;

  for (const entry of timelineEntries) {
    if (entry.kind !== "message") {
      continue;
    }
    if (entry.message.role === "user") {
      exchangeIndex += 1;
      continue;
    }
    if (entry.message.role !== "assistant") {
      continue;
    }

    const exchangeKey = `exchange:${exchangeIndex}`;
    const voice = entry.message.modality === "voice";
    if (voice && entry.message.turnId && turnIdsWithTextAssistant.has(entry.message.turnId)) {
      continue;
    }
    const previous = terminalCandidateByExchange.get(exchangeKey);
    if (!previous || !voice || previous.voice) {
      terminalCandidateByExchange.set(exchangeKey, {
        messageId: entry.message.id,
        voice,
      });
    }
  }

  return new Set([...terminalCandidateByExchange.values()].map((candidate) => candidate.messageId));
}

/**
 * Provider text can start streaming before later tool and Voice projection
 * events, so its immutable createdAt does not necessarily describe its final
 * visual position. Keep the canonical durable answer after every supporting
 * entry from the same turn without changing the persisted event chronology.
 */
function orderTerminalAssistantMessagesAfterTurnActivity(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  terminalAssistantMessageIds: ReadonlySet<string>,
  unsettledTurnId: TurnId | null,
): ReadonlyArray<TimelineEntry> {
  const terminalEntryByTurnId = new Map<TurnId, Extract<TimelineEntry, { kind: "message" }>>();
  const lastActivityIndexByTurnId = new Map<TurnId, number>();
  const lastVoiceIndexByTurnId = new Map<TurnId, number>();
  const entryIndexById = new Map<string, number>();

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    if (!entry) continue;

    entryIndexById.set(entry.id, index);
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) continue;

    lastActivityIndexByTurnId.set(turnId, index);
    if (entry.kind === "message" && entry.message.modality === "voice") {
      lastVoiceIndexByTurnId.set(turnId, index);
    }
    if (entry.kind === "message" && terminalAssistantMessageIds.has(entry.message.id)) {
      terminalEntryByTurnId.set(turnId, entry);
    }
  }

  const deferredTerminalByIndex = new Map<number, TimelineEntry>();
  const deferredTerminalEntryIds = new Set<string>();
  for (const [turnId, terminalEntry] of terminalEntryByTurnId) {
    if (turnId === unsettledTurnId) {
      continue;
    }
    const terminalIndex = entryIndexById.get(terminalEntry.id);
    const lastActivityIndex = lastActivityIndexByTurnId.get(turnId);
    const lastVoiceIndex = lastVoiceIndexByTurnId.get(turnId);
    if (
      terminalIndex === undefined ||
      lastActivityIndex === undefined ||
      lastVoiceIndex === undefined ||
      terminalIndex >= lastVoiceIndex
    ) {
      continue;
    }
    deferredTerminalEntryIds.add(terminalEntry.id);
    deferredTerminalByIndex.set(lastActivityIndex, terminalEntry);
  }

  if (deferredTerminalEntryIds.size === 0) {
    return timelineEntries;
  }

  const orderedEntries: TimelineEntry[] = [];
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    if (!entry) continue;
    if (!deferredTerminalEntryIds.has(entry.id)) {
      orderedEntries.push(entry);
    }
    const deferredTerminal = deferredTerminalByIndex.get(index);
    if (deferredTerminal) {
      orderedEntries.push(deferredTerminal);
    }
  }
  return orderedEntries;
}

interface TurnFold {
  foldId: string;
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  images: NonNullable<WorkLogEntry["images"]>;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  exchangeAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface ExchangeGroup {
    key: string;
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    turnIds: Set<TurnId>;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groups: ExchangeGroup[] = [];
  let currentGroup: ExchangeGroup | null = null;
  let orphanGroupIndex = 0;

  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      currentGroup = {
        key: `exchange:${entry.message.id}`,
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        turnIds: new Set(),
        startBoundary: entry.message.createdAt,
      };
      groups.push(currentGroup);
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    if (!currentGroup) {
      currentGroup = {
        key: `orphan:${turnId}:${orphanGroupIndex}`,
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        turnIds: new Set(),
        startBoundary: null,
      };
      orphanGroupIndex += 1;
      groups.push(currentGroup);
    }
    currentGroup.entries.push(entry);
    currentGroup.turnIds.add(turnId);
    if (entry.kind === "message") {
      if (input.exchangeAssistantMessageIds.has(entry.message.id)) {
        currentGroup.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        currentGroup.hasStreamingMessage = true;
      }
    }
  }

  const groupCountByTurnId = new Map<TurnId, number>();
  const lastGroupIndexByTurnId = new Map<TurnId, number>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group || group.entries.length === 0) continue;
    for (const turnId of group.turnIds) {
      groupCountByTurnId.set(turnId, (groupCountByTurnId.get(turnId) ?? 0) + 1);
      lastGroupIndexByTurnId.set(turnId, index);
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!group || group.entries.length === 0) {
      continue;
    }
    if (input.unsettledTurnId !== null && group.turnIds.has(input.unsettledTurnId)) continue;
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    const anchorEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    if (!firstEntry || !lastEntry || !anchorEntry) {
      continue;
    }

    const terminalTurnId =
      group.terminalEntry?.message.turnId ?? [...group.turnIds].at(-1) ?? [...group.turnIds][0];
    if (!terminalTurnId) continue;

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === terminalTurnId &&
      input.latestTurn.state === "interrupted" &&
      lastGroupIndexByTurnId.get(terminalTurnId) === groupIndex;
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === terminalTurnId &&
      groupCountByTurnId.get(terminalTurnId) === 1 &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";
    const images = group.entries.flatMap((entry) =>
      entry.kind === "work" ? (entry.entry.images ?? []) : [],
    );

    const foldId =
      group.turnIds.size === 1 && groupCountByTurnId.get(terminalTurnId) === 1
        ? terminalTurnId
        : `${terminalTurnId}:${group.key}`;

    foldsByAnchorEntryId.set(anchorEntry.id, {
      foldId,
      turnId: terminalTurnId,
      anchorEntryId: anchorEntry.id,
      createdAt: anchorEntry.createdAt,
      hiddenEntryIds,
      label,
      images,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<string>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const timelineEntries = orderTerminalAssistantMessagesAfterTurnActivity(
    input.timelineEntries,
    terminalAssistantMessageIds,
    unsettledTurnId,
  );
  const exchangeAssistantMessageIds = deriveExchangeAssistantMessageIds(timelineEntries);
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries,
    exchangeAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.foldId) && !input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.foldId}`,
        createdAt: turnFold.createdAt,
        foldId: turnFold.foldId,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded:
          input.expandedTurnIds?.has(turnFold.foldId) === true ||
          input.expandedTurnIds?.has(turnFold.turnId) === true,
        images: turnFold.images,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          // Agent-spawn CTA rows are always visible: a running fleet must
          // never hide behind a "+N tool calls" toggle. Selection is by
          // membership (spawn OR recent-tail), preserving the group's
          // chronological order in both collapsed and expanded states
          // (review finding: concatenating two filtered lists moved a
          // mid-group spawn row above earlier tool rows).
          const overflowCandidates = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn === undefined,
          );
          const hiddenEntries = overflowCandidates.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const hiddenIds = new Set(hiddenEntries.map((entry) => entry.id));
          const visibleEntries = visibleGroupedEntries.filter(
            (entry) => entry.agentSpawn !== undefined || !hiddenIds.has(entry.id),
          );
          const renderedEntries = expanded ? visibleGroupedEntries : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          if (hiddenEntries.length > 0) {
            nextRows.push({
              kind: "work-toggle",
              id: `work-toggle:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              groupId,
              hiddenCount: hiddenEntries.length,
              expanded,
              onlyToolEntries: visibleGroupedEntries.every((entry) =>
                workLogEntryIsToolLike(entry),
              ),
            });
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "turn-plan") {
      nextRows.push({
        kind: "turn-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnPlan: timelineEntry.turnPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.foldId === bf.foldId &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        Equal.equals(a.images, bf.images)
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "turn-plan": {
      const bp = b as typeof a;
      // Plans rewrite in place: compare the snapshot's identity fields so an
      // unchanged plan keeps its row reference (virtualization stability).
      return a.createdAt === bp.createdAt && a.turnPlan.plan === bp.turnPlan.plan;
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
