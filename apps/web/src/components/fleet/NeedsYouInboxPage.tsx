import { useState } from "react";

import type { NeedsYouItemId } from "@shuv2code/contracts";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useAdeNeedsYouList } from "../../state/ade";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { NeedsYouCard } from "./NeedsYouCard";
import { selectNeedsYouEntry } from "./NeedsYouInbox.logic";

/**
 * The Needs You inbox (spec §7 slice 5): badge → list → detail with
 * approve/deny. The canonical surface for the durable item pipeline; the same
 * items also render inline wherever their subject is on screen, and either one
 * resolves the item.
 */
export function NeedsYouInboxPage() {
  const [includeResolved, setIncludeResolved] = useState(false);
  const [selectedId, setSelectedId] = useState<NeedsYouItemId | null>(null);
  const list = useAdeNeedsYouList({ includeResolved });
  const entries = list.data?.entries ?? [];
  const selected = selectNeedsYouEntry(entries, selectedId);

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
            <WorkspaceBreadcrumb ariaLabel="Needs You breadcrumb">
              <WorkspaceBreadcrumbItem>Fleet</WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbItem current>Needs You</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-base font-medium">Needs You</h1>
              <Button
                onClick={() => setIncludeResolved((previous) => !previous)}
                size="sm"
                variant="ghost"
              >
                {includeResolved ? "Hide resolved" : "Show resolved"}
              </Button>
            </div>
            {list.error === null ? null : (
              <p className="text-sm text-destructive" role="alert">
                {list.error}
              </p>
            )}
            {list.data === null && list.isPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
              </div>
            ) : entries.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Nothing needs you</EmptyTitle>
                  <EmptyDescription>
                    Approvals, stalled work, and kernel outages land here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {entries.map((entry) => (
                    <li key={entry.item.id}>
                      <button
                        aria-current={selected?.item.id === entry.item.id}
                        className={cn(
                          "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
                          selected?.item.id === entry.item.id ? "bg-accent" : null,
                        )}
                        onClick={() => setSelectedId(entry.item.id)}
                        type="button"
                      >
                        <span className="block truncate font-medium">{entry.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.detail}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {selected === null ? null : <NeedsYouCard entry={selected} />}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
