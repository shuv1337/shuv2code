import { createFileRoute, Link } from "@tanstack/react-router";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { WorkGraphPanel } from "../components/fleet/WorkGraphPanel";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/**
 * The fleet-wide work graph (spec §7 slice 4). The same panel renders
 * project-scoped inside the project view; here the scope is `null`, so
 * cross-project delegation is visible as one lineage instead of two halves.
 */
export const Route = createFileRoute("/_chat/fleet_/work")({
  component: WorkGraphRouteView,
});

function WorkGraphRouteView() {
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
            <WorkspaceBreadcrumb ariaLabel="Work graph breadcrumb">
              <WorkspaceBreadcrumbItem>
                <Link to="/fleet">Fleet</Link>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbItem current>Work graph</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            <WorkGraphPanel projectId={null} />
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
