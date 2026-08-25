import type { AdeProjectId, BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import {
  FolderGit2Icon,
  FunnelXIcon,
  NetworkIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useAdeEnvironmentId, useAdeNeedsYouList, useAdeRoster } from "../../state/ade";
import { RAIL_TITLEBAR_INSET_CLASS, RAIL_TITLEBAR_TOP_INSET_CLASS } from "../../workspaceTitlebar";
import { SidebarKernelHealthPills } from "../sidebar/SidebarKernelHealthPills";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FirstProjectCta } from "./CaptainIndexPane";
import { ContactGroupSection } from "./ContactGroupSection";
import { FleetAttentionSection } from "./FleetAttentionSection";
import { NewBotPopover } from "./NewBotPopover";
import type { CaptainShellRegions } from "./captainShell.logic";
import { canToggleCaptainLeftRail, captainLeftRailToggleLabel } from "./captainShell.logic";
import {
  applyContactRailFilter,
  contactRailEmptyCopy,
  filterContactRows,
  fleetLevelNeedsYouEntries,
  getContactGroupSections,
  getContactRowViews,
  rosterNeedsFirstProject,
  shouldShowFirstProjectCtaInRail,
  type ContactRailFilter,
} from "./contactRail.logic";

/**
 * The captain's contacts (§2 LEFT RAIL). Every bot is a contact; the server
 * owns the order, so the Firstmate stays pinned without this file sorting.
 *
 * The rail is the roster now — `FleetRosterPage` is gone — so it also carries
 * what that page owned and nothing else does yet: creating a bot from a
 * template, the first-project CTA (#141), the kernel health pills, and the way
 * into the project and work-graph pages (§5.4 keeps those as full analysis
 * surfaces reached from the shell, not messenger scope). All of that has to
 * survive every rail width, not just the widest one.
 */
export function ContactRail({
  activeBotId,
  regions,
  onToggleCollapsed,
  filter = "all",
  onFilterChange,
}: {
  readonly activeBotId: BotId | null;
  readonly regions: CaptainShellRegions;
  readonly onToggleCollapsed: () => void;
  /**
   * The `?filter=` view (§5.4). This is what retires `/fleet/needs-you`: the
   * inbox was a separate page listing the same bots the rail already lists, so
   * it becomes a view *of* the rail rather than a destination away from it.
   */
  readonly filter?: ContactRailFilter;
  readonly onFilterChange?: (next: ContactRailFilter) => void;
}) {
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster();
  const [query, setQuery] = useState("");
  const collapsed = regions.leftRail === "icon";

  const rows = useMemo(() => getContactRowViews(roster.data), [roster.data]);
  // A collapsed rail has no search box, so a stale query must not silently
  // hide contacts the captain can no longer see they filtered.
  const effectiveQuery = collapsed ? "" : query;
  const sections = useMemo(
    () =>
      getContactGroupSections(
        applyContactRailFilter(filterContactRows(rows, effectiveQuery), filter),
        roster.data?.groups,
      ),
    [rows, effectiveQuery, filter, roster.data?.groups],
  );
  // Open items with no bot to sit under (D4). Read here rather than inside the
  // section because the empty state depends on it too: "Nothing needs you" over
  // an unreachable kernel-down item is the badge lie in a new place.
  const needsYou = useAdeNeedsYouList();
  const fleetAttention = useMemo(
    () => fleetLevelNeedsYouEntries(needsYou.data?.entries),
    [needsYou.data?.entries],
  );
  const attentionCount = useMemo(
    () => rows.filter((row) => row.attentionLine !== null).length + fleetAttention.length,
    [rows, fleetAttention.length],
  );

  const loading = roster.data === null && roster.isPending;
  const emptyCopy = contactRailEmptyCopy({
    totalRows: rows.length,
    query: effectiveQuery,
    filter,
  });
  // Below 900px the conversation region does not exist at the index route, so
  // `CaptainIndexPane` — and with it the only "create your first project" CTA —
  // never renders. The rail carries it instead. A captain with no project
  // cannot create a bot that can do anything, so this CTA has to exist at every
  // width.
  const showCtaInRail = shouldShowFirstProjectCtaInRail({
    needsFirstProject: rosterNeedsFirstProject(roster.data),
    showCenter: regions.showCenter,
    railCollapsed: collapsed,
  });

  return (
    <div
      aria-label="Contacts"
      className={cn(
        "flex h-full min-h-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground",
        collapsed ? "items-stretch px-1.5" : "px-2",
      )}
    >
      {/*
        The rail is the leftmost surface on this route now (#216), so its header
        is what sits under the macOS traffic lights — the app sidebar is not
        there to take that inset for it. The 64px strip is narrower than the
        lights are wide, so it drops below the titlebar band instead of insetting
        into it.
      */}
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 pb-1 transition-[padding] duration-200 ease-linear motion-reduce:transition-none",
          isElectron && "drag-region",
          collapsed
            ? ["flex-col pt-2", RAIL_TITLEBAR_TOP_INSET_CLASS]
            : [
                "h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] justify-between",
                RAIL_TITLEBAR_INSET_CLASS,
              ],
        )}
      >
        <span className={cn("flex min-w-0 items-center gap-1", collapsed && "flex-col")}>
          <WorkspaceSwitcher collapsed={collapsed} />
          {collapsed ? null : <span className="truncate text-sm font-semibold">Fleet</span>}
        </span>
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

      {/*
        The 64px strip has no room for the chip row, but it must not silently
        hide a fleet: a captain who narrows the window while the Attention view
        is on would otherwise see most of their contacts vanish with nothing on
        screen saying why, and no way back. One labelled control both announces
        the filter and clears it.
      */}
      {collapsed && filter === "attention" && onFilterChange !== undefined ? (
        <div className="flex shrink-0 justify-center pb-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Showing bots that need you — show all contacts"
                  className="size-8 rounded-full text-amber-600 dark:text-amber-400"
                  onClick={() => onFilterChange("all")}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <FunnelXIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">
              Showing bots that need you{attentionCount > 0 ? ` (${attentionCount})` : ""} — show
              all
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}

      {collapsed ? null : (
        <div className="flex shrink-0 flex-col gap-1.5 pb-2">
          <div className="relative">
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
          {/*
            Shown only when the view is reachable or already active: a captain
            with a quiet fleet gets their contacts, not a permanent tab
            advertising an inbox that is empty. Staying visible while `filter`
            is "attention" is what keeps the way *back* from a deep link.
          */}
          {onFilterChange !== undefined && (attentionCount > 0 || filter === "attention") ? (
            <div className="flex items-center gap-1" role="group" aria-label="Filter contacts">
              <RailFilterChip
                active={filter === "all"}
                label="All"
                onSelect={() => onFilterChange("all")}
              />
              <RailFilterChip
                active={filter === "attention"}
                label={attentionCount > 0 ? `Attention (${attentionCount})` : "Attention"}
                onSelect={() => onFilterChange("attention")}
              />
            </div>
          ) : null}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 pb-2">
          {showCtaInRail ? (
            <FirstProjectCta className="mb-1 bg-background" environmentId={environmentId} />
          ) : null}
          {roster.error === null ? null : (
            <p className="px-2 py-1 text-sm text-destructive" role="alert">
              {roster.error}
            </p>
          )}
          {/*
            Above the contacts, and only in the Attention view: these are the
            open items that name no bot, so the rail has nowhere else to put
            them and the sidebar badge counts them regardless (D4).
          */}
          {filter === "attention" && !collapsed ? (
            <FleetAttentionSection entries={fleetAttention} />
          ) : null}
          {loading ? (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ) : sections.length === 0 ? (
            // The fleet-wide section is itself an answer, so the rail is only
            // empty when that is empty too — otherwise "Nothing needs you"
            // renders directly above something that does.
            collapsed || fleetAttention.length > 0 ? null : (
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
 * The way back out of the captain surface (#216).
 *
 * With the app sidebar gone from these routes, the rail is the only left rail —
 * which means it is also the only thing that can carry the return trip. The app
 * mark is the affordance because it is the same mark, in the same corner, that
 * goes to `/` from the workspace sidebar header ("Go to threads"): the two
 * surfaces switch through one recognisable control rather than through a
 * captain-only invention.
 *
 * `SidebarFleetEntry` remains the way *in*, untouched. This is the other half
 * of that trip, not a duplicate of it.
 *
 * Exported for tests: with the app sidebar gone this is the *only* way back to
 * the coding interface from the captain surface, so where it points is worth
 * asserting rather than eyeballing.
 */
export function WorkspaceSwitcher({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Back to workspace threads"
            render={<Link to="/" />}
            size="icon-sm"
            variant="ghost"
          >
            <img
              alt=""
              aria-hidden
              className="size-[22px] shrink-0"
              src="/brand/shuv2code-mark.svg"
            />
          </Button>
        }
      />
      <TooltipPopup side={collapsed ? "right" : "bottom"}>Back to workspace threads</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Rail footer (§2): the analysis surfaces, Settings, and the demoted kernel
 * health pills, whose home is now this footer **in every rail mode**. They used
 * to sit in the app sidebar footer and so were visible app-wide; a captain who
 * narrows the window must not lose sight of a degraded kernel, and
 * `/fleet/projects/$adeProjectId` must not lose its only entry point.
 *
 * #216 audited what else disappears with the app sidebar and settled the split
 * here. **Settings** is absorbed — already present, and it stays, because it is
 * app-wide state (appearance, connections, keybindings) a captain reaches for
 * without a coding thread in mind. **Pull Requests** and **Usage** are not:
 * both are workspace analysis surfaces about the coding interface's own work,
 * they are one click away through the app mark at the rail top, and adding them
 * would rebuild the second sidebar's footer inside the first. The account row
 * stays workspace-only for the same reason.
 */
/**
 * One rail view toggle. A button rather than a link even though the state
 * lives in the URL: the route owns the navigation, and giving the chip its own
 * `to` would put the same decision in two places and make the pressed state a
 * second source of truth about which view is showing.
 */
function RailFilterChip({
  active,
  label,
  onSelect,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn("h-6 rounded-full px-2.5 text-xs", active && "bg-sidebar-row-hover")}
      onClick={onSelect}
      size="sm"
      type="button"
      variant="ghost"
    >
      {label}
    </Button>
  );
}

function RailFooter({
  collapsed,
  projects,
}: {
  readonly collapsed: boolean;
  readonly projects: ReadonlyArray<{ readonly id: AdeProjectId; readonly name: string }>;
}) {
  if (collapsed) {
    return (
      <footer className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border py-2">
        {projects.map((project) => (
          <Tooltip key={project.id}>
            <TooltipTrigger
              render={
                <Button
                  aria-label={project.name}
                  render={
                    <Link
                      params={{ adeProjectId: project.id }}
                      to="/fleet/projects/$adeProjectId"
                    />
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <FolderGit2Icon />
                </Button>
              }
            />
            <TooltipPopup side="right">{project.name}</TooltipPopup>
          </Tooltip>
        ))}
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
        <SidebarKernelHealthPills compact />
      </footer>
    );
  }

  return (
    <footer className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border py-2">
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
    </footer>
  );
}
