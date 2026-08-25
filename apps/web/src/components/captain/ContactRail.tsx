import type { AdeProjectId, BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import { FolderGit2Icon, NetworkIcon, PanelLeftIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useAdeRoster } from "../../state/ade";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarKernelHealthPills } from "../sidebar/SidebarKernelHealthPills";
import { ContactGroupSection } from "./ContactGroupSection";
import { NewBotPopover } from "./NewBotPopover";
import type { CaptainShellRegions } from "./captainShell.logic";
import { canToggleCaptainLeftRail, captainLeftRailToggleLabel } from "./captainShell.logic";
import {
  contactRailEmptyCopy,
  filterContactRows,
  getContactGroupSections,
  getContactRowViews,
} from "./contactRail.logic";

/**
 * The captain's contacts (§2 LEFT RAIL). Every bot is a contact; the server
 * owns the order, so the Firstmate stays pinned without this file sorting.
 *
 * The rail is the roster now — `FleetRosterPage` is gone — so it also carries
 * what that page owned and nothing else does yet: creating a bot from a
 * template, and the way into the project and work-graph pages (§5.4 keeps
 * those as full analysis surfaces reached from the shell, not messenger
 * scope).
 */
export function ContactRail({
  activeBotId,
  regions,
  onToggleCollapsed,
}: {
  readonly activeBotId: BotId | null;
  readonly regions: CaptainShellRegions;
  readonly onToggleCollapsed: () => void;
}) {
  const roster = useAdeRoster();
  const [query, setQuery] = useState("");
  const collapsed = regions.leftRail === "icon";

  const rows = useMemo(() => getContactRowViews(roster.data), [roster.data]);
  // A collapsed rail has no search box, so a stale query must not silently
  // hide contacts the captain can no longer see they filtered.
  const effectiveQuery = collapsed ? "" : query;
  const sections = useMemo(
    () => getContactGroupSections(filterContactRows(rows, effectiveQuery)),
    [rows, effectiveQuery],
  );

  const loading = roster.data === null && roster.isPending;
  const emptyCopy = contactRailEmptyCopy({ totalRows: rows.length, query: effectiveQuery });

  return (
    <div
      aria-label="Contacts"
      className={cn(
        "flex h-full min-h-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground",
        collapsed ? "items-stretch px-1.5" : "px-2",
      )}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 pt-2 pb-1",
          collapsed ? "flex-col" : "justify-between",
        )}
      >
        {collapsed ? null : <span className="ps-1 text-sm font-semibold">Fleet</span>}
        <span className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <NewBotPopover
            collapsed={collapsed}
            projects={roster.data?.projects ?? []}
            templates={roster.data?.templates ?? []}
          />
          {canToggleCaptainLeftRail(regions.mode) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={captainLeftRailToggleLabel(regions)}
                    onClick={onToggleCollapsed}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PanelLeftIcon />
                  </Button>
                }
              />
              <TooltipPopup side={collapsed ? "right" : "bottom"}>
                {captainLeftRailToggleLabel(regions)}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </header>

      {collapsed ? null : (
        <div className="relative shrink-0 pb-2">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-muted-foreground"
          />
          <Input
            aria-label="Search contacts"
            className="ps-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search bots"
            type="search"
            value={query}
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 pb-2">
          {roster.error === null ? null : (
            <p className="px-2 py-1 text-sm text-destructive" role="alert">
              {roster.error}
            </p>
          )}
          {loading ? (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ) : sections.length === 0 ? (
            collapsed ? null : (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyTitle>{emptyCopy.title}</EmptyTitle>
                  <EmptyDescription>{emptyCopy.description}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : (
            sections.map((section, index) => (
              <ContactGroupSection
                activeBotId={activeBotId}
                collapsed={collapsed}
                key={section.groupId}
                section={section}
                // One implicit "Ungrouped" header over the whole fleet says
                // nothing; M2's captain-defined groups turn these on.
                showDivider={collapsed && index > 0}
                showHeader={regions.showGroupHeaders && sections.length > 1}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <RailFooter collapsed={collapsed} projects={roster.data?.projects ?? []} />
    </div>
  );
}

/**
 * Rail footer (§2): the analysis surfaces, Settings, and the demoted kernel
 * health pills. The pills used to sit in the app sidebar footer beside the
 * Fleet nav row; the messenger is the fleet surface now, so their audience is
 * here.
 */
function RailFooter({
  collapsed,
  projects,
}: {
  readonly collapsed: boolean;
  readonly projects: ReadonlyArray<{ readonly id: AdeProjectId; readonly name: string }>;
}) {
  return (
    <footer className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border py-2">
      {collapsed ? (
        <div className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Work graph"
                  render={<Link to="/fleet/work" />}
                  size="icon-sm"
                  variant="ghost"
                >
                  <NetworkIcon />
                </Button>
              }
            />
            <TooltipPopup side="right">Work graph</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Settings"
                  render={<Link to="/settings" />}
                  size="icon-sm"
                  variant="ghost"
                >
                  <SettingsIcon />
                </Button>
              }
            />
            <TooltipPopup side="right">Settings</TooltipPopup>
          </Tooltip>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 px-1">
            {projects.map((project) => (
              <Button
                key={project.id}
                render={
                  <Link params={{ adeProjectId: project.id }} to="/fleet/projects/$adeProjectId">
                    <FolderGit2Icon aria-hidden />
                    {project.name}
                  </Link>
                }
                size="compact"
                variant="ghost"
              />
            ))}
            <Button
              render={
                <Link to="/fleet/work">
                  <NetworkIcon aria-hidden />
                  Work graph
                </Link>
              }
              size="compact"
              variant="ghost"
            />
            <Button
              render={
                <Link to="/settings">
                  <SettingsIcon aria-hidden />
                  Settings
                </Link>
              }
              size="compact"
              variant="ghost"
            />
          </div>
          <SidebarKernelHealthPills />
        </>
      )}
    </footer>
  );
}
