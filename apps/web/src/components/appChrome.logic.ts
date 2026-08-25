import type { RegisteredRouter, RouteIds } from "@tanstack/react-router";

/**
 * Which app chrome a route gets (#216, MESSENGER-PIVOT §2).
 *
 * The captain surface has its own left rail — the contacts rail *is* the rail
 * there — so the workspace app sidebar must not render alongside it. Two left
 * sidebars stacked against each other was the whole complaint.
 *
 * The decision is made from **route ids**, not from the pathname, and not from
 * CSS. A pathname prefix would silently capture every future `/fleet/*` route,
 * including the ones that deliberately keep the workspace sidebar (see below);
 * a CSS hide would leave the sidebar's provider, its `fixed` collapse trigger,
 * its titlebar-inset machinery and its keyboard shortcut mounted and active
 * behind an invisible panel. The route either mounts the workspace chrome or it
 * does not.
 */
export type AppRouteId = RouteIds<RegisteredRouter["routeTree"]>;

/**
 * The routes that render `CaptainShell` and therefore own their own left rail.
 *
 * Typed as real route ids so renaming or moving one of these files fails
 * typecheck here rather than quietly restoring the duelling sidebars.
 *
 * Deliberately **only** the two messenger shell routes:
 *
 * - `/fleet/work` and `/fleet/projects/$adeProjectId` are full-page analysis
 *   surfaces (§5.4). They render a bare `SidebarInset` with no contacts rail of
 *   their own, so taking the workspace sidebar away from them would leave them
 *   with no left navigation at all.
 * - `/fleet/needs-you` and `/fleet/$botId/chat` are redirect stubs; they never
 *   render.
 */
export const CAPTAIN_SHELL_ROUTE_IDS: ReadonlyArray<AppRouteId> = [
  "/_chat/fleet",
  "/_chat/fleet_/$botId",
];

const CAPTAIN_SHELL_ROUTE_ID_SET: ReadonlySet<string> = new Set<string>(CAPTAIN_SHELL_ROUTE_IDS);

/**
 * Whether the matched route stack renders its own left rail, and so must not
 * get the workspace app sidebar.
 *
 * Takes the whole matched stack rather than the leaf because that is what
 * `useMatches` hands back, and because a nested route under a captain shell
 * route would inherit the shell's rail along with everything else.
 */
export function hidesWorkspaceSidebar(routeIds: Iterable<string>): boolean {
  for (const routeId of routeIds) {
    if (CAPTAIN_SHELL_ROUTE_ID_SET.has(routeId)) {
      return true;
    }
  }
  return false;
}
