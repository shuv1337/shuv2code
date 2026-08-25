import type { CSSProperties, ReactNode } from "react";

import {
  MACOS_TRAFFIC_LIGHTS_LEFT_INSET,
  RAIL_TITLEBAR_INSET_ATTRIBUTE,
} from "../../workspaceTitlebar";

/**
 * The app frame for routes that own their own left rail (#216).
 *
 * The captain surface stands in for `SidebarProvider` + `Sidebar` here, and the
 * substitution is deliberate rather than incidental. What the sidebar provider
 * gave the page was: a full-height flex wrapper, a `--sidebar-width` nobody on
 * this surface reads, a `--workspace-titlebar-content-left` that budgets room
 * for the app sidebar's `fixed` collapse trigger, and a `data-sidebar-state`
 * attribute that every workspace header keys its titlebar inset off. Only the
 * first of those means anything without a sidebar; carrying the rest across
 * would be the sidebar's machinery leaking into a surface that does not have
 * one — a trigger with nothing to toggle, and headers insetting around it.
 *
 * So this frame supplies exactly two things:
 *
 * 1. the wrapper geometry, and
 * 2. the traffic-light contract — because the contacts rail is now the leftmost
 *    surface on this route, and on a frameless macOS window the lights land on
 *    top of it.
 *
 * `--workspace-controls-left` is overridden for the same reason
 * `AppSidebarLayout` overrides it: the default is a ~12px gutter measured from
 * the window edge, which on macOS is underneath the lights.
 */
export function CaptainAppFrame({
  children,
  macosTrafficLights,
}: {
  readonly children: ReactNode;
  /** From `useMacosTrafficLightsInset`; a prop so the frame renders in tests. */
  readonly macosTrafficLights: boolean;
}) {
  return (
    <div
      className="flex h-dvh min-h-0 w-full"
      data-captain-app-frame=""
      {...(macosTrafficLights ? { [RAIL_TITLEBAR_INSET_ATTRIBUTE]: "" } : {})}
      style={
        macosTrafficLights
          ? ({ "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET } as CSSProperties)
          : undefined
      }
    >
      {children}
    </div>
  );
}
