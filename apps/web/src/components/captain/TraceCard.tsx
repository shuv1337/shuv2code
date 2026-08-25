import {
  BrainIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  InfoIcon,
  ListChecksIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { CaptainRowHost, type CaptainRowHostDisplayState } from "./CaptainRowHost";
import { formatTraceDuration, resolveTraceCardSummary } from "./bubbleTimeline.logic";

const TONE_ICON = {
  thinking: BrainIcon,
  tool: TerminalIcon,
  info: InfoIcon,
  error: CircleAlertIcon,
  plan: ListChecksIcon,
} as const;

/**
 * **The seam** (MESSENGER-PIVOT §3).
 *
 * Everything the bubble renderer cannot claim losslessly — tool calls, work
 * groups, turn folds, diffs, plans, and any row kind invented after this file
 * was written — arrives here as a collapsed one-liner and expands into the
 * *real* IDE row through `CaptainRowHost`.
 *
 * That is the whole bet: one source of truth for message semantics, no second
 * parser, and a new provider event kind that degrades to IDE-fidelity rendering
 * rather than to a blank bubble. The collapsed summary is pure
 * (`resolveTraceCardSummary`) so what the captain reads before expanding is
 * pinned by tests instead of by a screenshot.
 */
export function TraceCard({
  row,
  display,
  defaultExpanded = false,
  className,
}: {
  readonly row: MessagesTimelineRow;
  readonly display: CaptainRowHostDisplayState;
  readonly defaultExpanded?: boolean;
  readonly className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const summary = resolveTraceCardSummary(row);
  const Icon = TONE_ICON[summary.tone];
  const duration = formatTraceDuration(summary.durationMs);

  // Two row kinds already *are* a collapsed one-liner with their own
  // disclosure — a turn fold and a work-group toggle. Wrapping those in a
  // second disclosure showed the captain the same label twice and made them
  // click through two chevrons to reach one thing. They get the genuine row
  // and nothing else; the seam is the same, the chrome is not doubled.
  if (row.kind === "turn-fold" || row.kind === "work-toggle") {
    return (
      <div className={cn("my-1", className)} data-trace-row-kind={row.kind}>
        <CaptainRowHost display={display} row={row} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "my-1 overflow-hidden rounded-xl border border-border/60 bg-muted/25",
        className,
      )}
      data-trace-row-id={row.id}
      data-trace-row-kind={row.kind}
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{summary.label}</span>
        {summary.hiddenCount > 0 && !expanded ? (
          <span className="shrink-0 tabular-nums">+{summary.hiddenCount}</span>
        ) : null}
        {duration === null ? null : <span className="shrink-0 tabular-nums">{duration}</span>}
        {summary.diffStat !== null && hasNonZeroStat(summary.diffStat) ? (
          <DiffStatLabel
            additions={summary.diffStat.additions}
            className="shrink-0"
            deletions={summary.diffStat.deletions}
            layout="inline"
          />
        ) : null}
      </button>
      {expanded ? (
        <div className="border-t border-border/60 bg-background px-2.5 py-2">
          {/*
           * The genuine IDE row, mounted outside `MessagesTimeline` through the
           * one exported host. No captain-specific branch runs inside it.
           */}
          <CaptainRowHost display={display} row={row} />
        </div>
      ) : null}
    </div>
  );
}
