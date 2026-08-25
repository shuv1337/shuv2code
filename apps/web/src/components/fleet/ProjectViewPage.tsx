import type { AdeProjectId, IntegrationCandidateStatus } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import {
  AnchorIcon,
  ArrowLeftIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useAdeProject,
  useAdeProjectCandidates,
  useAdeProjectPublicationStack,
} from "../../state/ade";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  CANDIDATE_STATUSES,
  candidateStatusCounts,
  candidateStatusLabel,
  getCandidateRowViews,
  getProjectCrewRowViews,
  getProjectHeaderView,
  getPublicationStackView,
  isProjectNotFound,
  unreadableRowsLabel,
} from "./ProjectViewPage.logic";
import { WorkGraphPanel } from "./WorkGraphPanel";

/**
 * The ADE project view (spec §7 slice 3): three stacked panels — crew,
 * integration queue, publication stack — plus the project-scoped work graph
 * (slice 4). Every panel reads its own RPC so the slow ones (a publication
 * pass is a GitHub round trip) do not force the fast one (a queue pass moves
 * in seconds) to wait, and vice versa.
 */
export function ProjectViewPage({ projectId }: { readonly projectId: AdeProjectId }) {
  const project = useAdeProject(projectId);
  const header = getProjectHeaderView(project.data);
  const notFound = isProjectNotFound(project.failure);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isElectron ? null : (
          <header
            className={cn(
              "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Project breadcrumb">
              <WorkspaceBreadcrumbItem>
                <Link to="/fleet">Fleet</Link>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbItem current>{header?.name ?? "Project"}</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            {notFound ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Project not found</EmptyTitle>
                  <EmptyDescription>
                    This project no longer exists. It may have been deleted from another window.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link to="/fleet">
                      <ArrowLeftIcon aria-hidden />
                      Back to the fleet
                    </Link>
                  }
                />
              </Empty>
            ) : (
              <>
                {project.error === null ? null : (
                  <p role="alert" className="text-sm text-destructive">
                    {project.error}
                  </p>
                )}

                {header === null && project.isPending ? (
                  <Skeleton className="h-24 w-full rounded-lg" />
                ) : header === null ? null : (
                  <div className="flex flex-col gap-2">
                    <h1 className="font-semibold text-xl">{header.name}</h1>
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
                      <Badge variant={header.isRepoBound ? "outline" : "warning"} size="sm">
                        <GitBranchIcon aria-hidden />
                        {header.repoLabel}
                      </Badge>
                      <Badge variant="secondary" size="sm">
                        {header.policyLabel}
                      </Badge>
                      <span>{header.checkCommandsLabel}</span>
                    </div>
                  </div>
                )}

                <CrewPanel projectId={projectId} />
                {/*
                  The three heavy panels only mount once the project has
                  answered. Without that gate a deleted project fans one 404 out
                  into four pollers, each retrying forever against a row that is
                  never coming back.
                */}
                {header === null ? null : (
                  <>
                    <IntegrationQueuePanel projectId={projectId} isRepoBound={header.isRepoBound} />
                    <PublicationStackPanel projectId={projectId} isRepoBound={header.isRepoBound} />
                    <WorkGraphPanel projectId={projectId} />
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — crew
// ---------------------------------------------------------------------------

function CrewPanel({ projectId }: { readonly projectId: AdeProjectId }) {
  const project = useAdeProject(projectId);
  const rows = getProjectCrewRowViews(project.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crew</CardTitle>
        <CardDescription>Bots whose home is this project.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.length === 0 && project.isPending ? (
          <Skeleton className="h-12 w-full rounded-md" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No crew yet.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.botId}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm">{row.name}</span>
                  {row.isSecondMate ? (
                    <Badge variant="secondary" size="sm">
                      <AnchorIcon aria-hidden />
                      Second Mate
                    </Badge>
                  ) : null}
                </div>
                <span className="truncate text-muted-foreground text-xs">
                  {row.roleLabel} · {row.roleTag}
                  {row.openAssignmentLabel === null ? "" : ` · ${row.openAssignmentLabel}`}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link to="/fleet/$botId/chat" params={{ botId: row.botId }}>
                    <MessageSquareIcon aria-hidden />
                    {row.chatLabel}
                  </Link>
                }
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel 2 — integration queue
// ---------------------------------------------------------------------------

function IntegrationQueuePanel({
  projectId,
  isRepoBound,
}: {
  readonly projectId: AdeProjectId;
  readonly isRepoBound: boolean;
}) {
  const [status, setStatus] = useState<IntegrationCandidateStatus | null>(null);
  const candidates = useAdeProjectCandidates(projectId);
  const all = candidates.data?.candidates ?? [];
  const counts = candidateStatusCounts(all);
  const rows = getCandidateRowViews(all, status);
  const unreadableLabel = unreadableRowsLabel(candidates.data?.unreadableRows ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integration queue</CardTitle>
        <CardDescription>
          One candidate runs at a time; the head is marked. Oldest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant={status === null ? "secondary" : "ghost"}
            onClick={() => setStatus(null)}
          >
            All {all.length}
          </Button>
          {CANDIDATE_STATUSES.map((candidateStatus) => (
            <Button
              key={candidateStatus}
              size="sm"
              variant={status === candidateStatus ? "secondary" : "ghost"}
              onClick={() => setStatus(status === candidateStatus ? null : candidateStatus)}
            >
              {candidateStatusLabel(candidateStatus)} {counts[candidateStatus]}
            </Button>
          ))}
        </div>

        {candidates.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {candidates.error}
          </p>
        )}
        {unreadableLabel === null ? null : (
          <p role="status" className="text-warning-foreground text-xs">
            {unreadableLabel}
          </p>
        )}

        {all.length === 0 && candidates.isPending ? (
          <Skeleton className="h-12 w-full rounded-md" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{all.length === 0 ? "Nothing queued" : "Nothing matches"}</EmptyTitle>
              <EmptyDescription>
                {all.length > 0
                  ? "Clear the status filter to see the rest of the queue."
                  : isRepoBound
                    ? "Candidates appear here when a bot submits work for integration."
                    : "Bind a repository to this project before it can integrate."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          rows.map((row) => (
            <div
              key={row.candidateId}
              className={cn(
                "flex flex-col gap-1.5 rounded-md border border-border px-3 py-2",
                row.isQueueHead && "border-primary/40 bg-accent/30",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={row.statusTone} size="sm">
                  {row.statusLabel}
                </Badge>
                {row.isQueueHead ? (
                  <Badge variant="outline" size="sm">
                    Queue head
                  </Badge>
                ) : null}
                {row.gateLabel === null ? null : (
                  <Badge variant="secondary" size="sm">
                    Gate: {row.gateLabel}
                  </Badge>
                )}
                {row.verdictLabel === null ? null : (
                  <Badge variant={row.verdictLabel === "Approved" ? "success" : "error"} size="sm">
                    {row.verdictLabel}
                  </Badge>
                )}
                {row.bounceCountLabel === null ? null : (
                  <span className="text-muted-foreground text-xs">{row.bounceCountLabel}</span>
                )}
              </div>
              <span className="truncate font-mono text-muted-foreground text-xs">
                {row.changeIdCount === 0 ? "No changes" : row.changeIdsLabel}
              </span>
              {row.bounceLabel === null ? null : (
                <p className="text-destructive text-xs">
                  {row.bounceLabel}
                  {row.bounceDetail === null ? "" : ` — ${row.bounceDetail}`}
                </p>
              )}
              {row.verdictDetail === null ? null : (
                <p className="text-muted-foreground text-xs">{row.verdictDetail}</p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel 3 — publication stack
// ---------------------------------------------------------------------------

function PublicationStackPanel({
  projectId,
  isRepoBound,
}: {
  readonly projectId: AdeProjectId;
  readonly isRepoBound: boolean;
}) {
  const query = useAdeProjectPublicationStack(projectId);
  const stack = getPublicationStackView(query.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Publication stack</CardTitle>
        <CardDescription>Layers bottom-up, with the PR state last read.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        )}

        {stack === null && query.isPending ? (
          <Skeleton className="h-12 w-full rounded-md" />
        ) : stack === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing published</EmptyTitle>
              <EmptyDescription>
                {isRepoBound
                  ? "A stack appears here once integrated work is published."
                  : "Bind a repository to this project before it can publish."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={stack.statusTone} size="sm">
                {stack.statusLabel}
              </Badge>
              <Badge variant="outline" size="sm">
                {stack.modeLabel}
              </Badge>
              {stack.nativeStackLabel === null ? null : (
                <Badge variant="secondary" size="sm">
                  {stack.nativeStackLabel}
                </Badge>
              )}
              {stack.stackUrl === null ? null : (
                <a
                  href={stack.stackUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary text-xs underline"
                >
                  Open stack
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              )}
            </div>
            {stack.layers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No layers yet.</p>
            ) : (
              stack.layers.map((layer) => (
                <div
                  key={layer.layerId}
                  className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{layer.orderLabel}</span>
                    <span className="truncate font-mono text-xs">{layer.bookmarkName}</span>
                    <Badge variant={layer.prTone} size="sm">
                      {layer.prLabel}
                      {layer.prState === null ? "" : ` · ${layer.prState}`}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      {layer.statusLabel}
                    </Badge>
                  </div>
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {layer.shaLabel ?? layer.changeIdsLabel}
                  </span>
                </div>
              ))
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
