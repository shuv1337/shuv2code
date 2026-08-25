import type { AdeProjectId, AssignmentStatus, BotId } from "@shuv2code/contracts";
import { CornerDownRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useAdeAssignmentGraph } from "../../state/ade";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  ASSIGNMENT_STATUSES,
  assignmentStatusLabel,
  getWorkGraphListRows,
  getWorkGraphTreeRows,
  workGraphIsFilteredEmpty,
  workGraphStatusCounts,
  type WorkGraphFilter,
  type WorkGraphRow,
} from "./WorkGraph.logic";

/** Sentinel for the "every bot" option — `Select` needs a non-null value. */
const ANY_BOT = "__any__";
const ANY_STATUS = "__any__";

type WorkGraphMode = "tree" | "list";

/**
 * Work graph (spec §7 slice 4): a filterable list and tree of assignment
 * lineage. No canvas — the tree is indented rows, which is all
 * `parentAssignmentId` can honestly say.
 *
 * Renders both as a project panel and as the fleet-wide page; `projectId` is
 * the only difference, and `null` means fleet-wide.
 */
export function WorkGraphPanel({ projectId }: { readonly projectId: AdeProjectId | null }) {
  const [mode, setMode] = useState<WorkGraphMode>("tree");
  const [filter, setFilter] = useState<WorkGraphFilter>({ botId: null, status: null });
  const query = useAdeAssignmentGraph(projectId);
  const graph = query.data ?? null;
  const counts = workGraphStatusCounts(graph);
  const rows =
    mode === "tree" ? getWorkGraphTreeRows(graph, filter) : getWorkGraphListRows(graph, filter);
  const filteredEmpty = workGraphIsFilteredEmpty(graph, rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work graph</CardTitle>
        <CardDescription>
          Assignment lineage{projectId === null ? " across the fleet" : ""}. Parents nest their
          children.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup value={[mode]}>
            <Toggle
              value="tree"
              aria-label="Tree view"
              pressed={mode === "tree"}
              onClick={() => setMode("tree")}
            >
              Tree
            </Toggle>
            <Toggle
              value="list"
              aria-label="List view"
              pressed={mode === "list"}
              onClick={() => setMode("list")}
            >
              List
            </Toggle>
          </ToggleGroup>

          <Select
            value={filter.botId ?? ANY_BOT}
            onValueChange={(value) =>
              setFilter((current) => ({
                ...current,
                botId: value === ANY_BOT ? null : (value as BotId),
              }))
            }
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Filter by bot">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ANY_BOT}>Every bot</SelectItem>
              {(graph?.bots ?? []).map((bot) => (
                <SelectItem key={bot.id} value={bot.id}>
                  {bot.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select
            value={filter.status ?? ANY_STATUS}
            onValueChange={(value) =>
              setFilter((current) => ({
                ...current,
                status: value === ANY_STATUS ? null : (value as AssignmentStatus),
              }))
            }
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ANY_STATUS}>Every status</SelectItem>
              {ASSIGNMENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {assignmentStatusLabel(status)} ({counts[status]})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {query.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        )}

        {graph === null && query.isPending ? (
          <Skeleton className="h-12 w-full rounded-md" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{filteredEmpty ? "Nothing matches" : "No assignments yet"}</EmptyTitle>
              <EmptyDescription>
                {filteredEmpty
                  ? "Clear the filters to see the rest of the lineage."
                  : "Assignments appear here once the captain or a bot delegates work."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <WorkGraphRowView key={row.assignmentId} row={row} showProject={projectId === null} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkGraphRowView({
  row,
  showProject,
}: {
  readonly row: WorkGraphRow;
  readonly showProject: boolean;
}) {
  return (
    <div
      // Indent is capped so a deep chain cannot push the text off the panel.
      style={{ marginInlineStart: `${Math.min(row.depth, 6) * 16}px` }}
      className={cn(
        "flex flex-col gap-1 rounded-md border border-border px-3 py-2",
        // A context row survives only because a descendant matched the filter.
        row.isContext && "border-dashed opacity-64",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {row.depth > 0 ? (
          <CornerDownRightIcon aria-hidden className="size-3 text-muted-foreground" />
        ) : null}
        <Badge variant={row.statusTone} size="sm">
          {row.statusLabel}
        </Badge>
        <span className="truncate font-medium text-sm">{row.botName}</span>
        {showProject && row.projectName !== null ? (
          <Badge variant="outline" size="sm">
            {row.projectName}
          </Badge>
        ) : null}
        {row.riskLabel === null ? null : (
          <Badge variant="warning" size="sm">
            {row.riskLabel}
          </Badge>
        )}
        {row.blockedLabel === null ? null : (
          <span className="text-muted-foreground text-xs">{row.blockedLabel}</span>
        )}
      </div>
      <p className="line-clamp-2 text-sm">{row.instruction}</p>
      {row.resultSummary === null ? null : (
        <p className="line-clamp-2 text-muted-foreground text-xs">{row.resultSummary}</p>
      )}
      {row.hiddenChildCount === 0 ? null : (
        <span className="text-muted-foreground text-xs">
          {row.hiddenChildCount === 1
            ? "1 child not shown"
            : `${row.hiddenChildCount} children not shown`}
        </span>
      )}
    </div>
  );
}
