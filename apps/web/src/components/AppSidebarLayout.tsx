import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useMatches, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import { useMacosTrafficLightsInset } from "../hooks/useMacosTrafficLightsInset";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useProjects } from "../state/entities";
import { useLegacySidebarEnabled } from "../hooks/useSettings";
import { MACOS_TRAFFIC_LIGHTS_LEFT_INSET } from "../workspaceTitlebar";
import { hidesWorkspaceSidebar } from "./appChrome.logic";
import { CaptainAppFrame } from "./captain/CaptainAppFrame";
import LegacyThreadSidebar from "./LegacySidebar";
import ThreadSidebar from "./Sidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader } from "./sidebar/SidebarChrome";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { resolveSidebarDefaultOpen } from "./ui/sidebarState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

/**
 * The persisted collapse preference, read at mount.
 *
 * `SidebarProvider` writes this cookie on every toggle and, before #216, no
 * code ever read it — the provider only unmounted with the document, so
 * `defaultOpen` was never consulted twice. The captain surface swaps the
 * provider out of the tree, so it now remounts on every return from `/fleet`
 * and this is what keeps a collapsed sidebar collapsed across the round trip.
 */
function readSidebarDefaultOpen(): boolean {
  try {
    return resolveSidebarDefaultOpen(document.cookie);
  } catch (error) {
    console.error("Could not read the persisted sidebar state.", error);
    return true;
  }
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  // While the sidebar is visible its own header hosts the trailing trigger;
  // this fixed control only serves the collapsed state.
  if (isSidebarVisible) {
    return null;
  }

  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric.
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  // #216: the captain shell routes render the contacts rail as *the* left rail.
  // Read from the matched route ids rather than the pathname so `/fleet/work`
  // and `/fleet/projects/$id` — full pages with no rail of their own — keep the
  // workspace sidebar they navigate with.
  const railOwnedByRoute = useMatches({
    select: (matches) => hidesWorkspaceSidebar(matches.map((match) => match.routeId)),
  });
  const macosTrafficLights = useMacosTrafficLightsInset();
  // Read on every render rather than held in state: the provider below is
  // unmounted while the captain surface is showing, so the value that matters
  // is the one at *its* next mount, not the one at this component's first.
  const sidebarDefaultOpen = readSidebarDefaultOpen();
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(macosTrafficLights
      ? {
          "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET,
          "--workspace-sidebar-brand-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET,
        }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  /*
   * #216. The captain surface gets one rail, and it is not this one. The
   * sidebar is not hidden below — it is not mounted, and neither is its
   * provider, its `fixed` collapse trigger, nor the `Cmd+B` handler (the
   * captain shell binds that command to the contacts rail instead).
   *
   * Two things sit deliberately *outside* the branch so that crossing it does
   * not disturb them:
   *
   * - `ProjectProjectionRetention` holds the same element position in both
   *   trees, so React keeps the one instance mounted across a fleet round trip
   *   rather than tearing the projection down and resubscribing.
   * - The desktop menu's "Settings" action is registered above; the app menu is
   *   app-wide, not workspace-only.
   *
   * What the branch *does* cost is the provider's own React state. Collapse is
   * recovered from the `sidebar_state` cookie via `defaultOpen`. The thread
   * search query and the list's scroll position are not recovered, and that is
   * accepted: they are per-visit context, they reset on reload today, and the
   * alternative — hoisting the provider above the branch — re-imports exactly
   * the machinery this ticket removed from the captain surface.
   */
  return (
    <>
      <ProjectProjectionRetention />
      {railOwnedByRoute ? (
        <CaptainAppFrame macosTrafficLights={macosTrafficLights}>{children}</CaptainAppFrame>
      ) : (
        <SidebarProvider
          className="h-dvh! min-h-0!"
          defaultOpen={sidebarDefaultOpen}
          style={sidebarProviderStyle}
        >
          <Sidebar
            side="left"
            collapsible="offcanvas"
            data-app-sidebar=""
            className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
            resizable={{
              maxWidth: sidebarMaximumWidth,
              minWidth: THREAD_SIDEBAR_MIN_WIDTH,
              shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                nextWidth <= currentWidth ||
                wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
              storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
              onResize: setSidebarWidth,
            }}
          >
            {isOnSettings ? (
              <>
                <SidebarChromeHeader isElectron={isElectron} />
                <SettingsSidebarNav pathname={pathname} />
              </>
            ) : legacySidebarEnabled ? (
              <LegacyThreadSidebar />
            ) : (
              <ThreadSidebar />
            )}
            <SidebarRail onDoubleClick={resetSidebarWidth} />
          </Sidebar>
          {children}
          <SidebarControl />
        </SidebarProvider>
      )}
    </>
  );
}
