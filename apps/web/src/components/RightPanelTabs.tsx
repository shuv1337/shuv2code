import type { ContextMenuItem, PreviewSessionSnapshot } from "@shuv2code/contracts";
import { getTerminalLabel } from "@shuv2code/shared/terminalLabels";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileDiff,
  Files,
  Globe2,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import {
  resolveHorizontalWheelScroll,
  resolveTabNavigationIndex,
  type TabNavigationKey,
} from "./rightPanelTabStrip";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface: (surfaceId: string, targetSurfaceId: string) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  children: ReactNode;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the shuv2code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
} as const;

type TabContextMenuAction =
  | "copy-path"
  | "move-left"
  | "move-right"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
    >
      {props.children}
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
}) {
  const actions = [
    {
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <Icon className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "plan":
      return "Plan";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function PreviewFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) return <Globe2 className="size-3.5 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function SurfaceIcon({
  surface,
  sessions,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3.5 shrink-0" />;
    case "files":
      return <Files className="size-3.5 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
    case "plan":
      return <ClipboardList className="size-3.5 shrink-0" />;
  }
}

interface SortableSurfaceTabProps {
  surface: RightPanelSurface;
  active: boolean;
  pending: boolean;
  title: string;
  tabIndex: number;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
  onActivate: (surface: RightPanelSurface) => void;
  onClose: (surface: RightPanelSurface) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, surface: RightPanelSurface) => void;
  setButtonRef: (surfaceId: string, node: HTMLButtonElement | null) => void;
}

function SortableSurfaceTab(props: SortableSurfaceTabProps) {
  const { listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.surface.id });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="presentation"
      data-active-tab={props.active}
      data-dragging-tab={isDragging || undefined}
      onMouseDown={props.onMouseDown}
      onAuxClick={(event) => props.onAuxClick(event, props.surface)}
      onContextMenu={(event) => props.onContextMenu(event, props.surface)}
      className={cn(
        "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm [-webkit-app-region:no-drag]",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "z-20 opacity-75 shadow-sm ring-1 ring-border",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={(node) => {
                setActivatorNodeRef(node);
                props.setButtonRef(props.surface.id, node);
              }}
              {...listeners}
              type="button"
              role="tab"
              aria-selected={props.active}
              aria-roledescription="sortable tab"
              aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              tabIndex={props.tabIndex}
              className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
              onClick={() => props.onActivate(props.surface)}
              onKeyDown={(event) => props.onKeyDown(event, props.surface)}
            >
              <SurfaceIcon surface={props.surface} sessions={props.sessions} theme={props.theme} />
              <span className="truncate">{props.title}</span>
            </button>
          }
        />
        <TooltipPopup>{props.title}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100",
          props.pending ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        aria-label={`Close ${props.title}`}
        onClick={() => props.onClose(props.surface)}
      >
        {props.pending ? (
          <>
            <span className="size-2 rounded-full bg-current group-hover:hidden" aria-hidden />
            <X className="hidden size-3 group-hover:block" />
          </>
        ) : (
          <X className="size-3" />
        )}
      </button>
    </div>
  );
}

interface TabOverflowState {
  hasOverflow: boolean;
  canScrollBack: boolean;
  canScrollForward: boolean;
}

const NO_TAB_OVERFLOW: TabOverflowState = {
  hasOverflow: false,
  canScrollBack: false,
  canScrollForward: false,
};

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabViewportRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [tabOverflow, setTabOverflow] = useState<TabOverflowState>(NO_TAB_OVERFLOW);
  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const setTabButtonRef = useCallback((surfaceId: string, node: HTMLButtonElement | null) => {
    if (node) tabButtonRefs.current.set(surfaceId, node);
    else tabButtonRefs.current.delete(surfaceId);
  }, []);

  const updateTabOverflow = useCallback(() => {
    const viewport = tabViewportRef.current;
    if (!viewport) return;
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const next = {
      hasOverflow: maxScrollLeft > 1,
      canScrollBack: viewport.scrollLeft > 1,
      canScrollForward: viewport.scrollLeft < maxScrollLeft - 1,
    };
    setTabOverflow((current) =>
      current.hasOverflow === next.hasOverflow &&
      current.canScrollBack === next.canScrollBack &&
      current.canScrollForward === next.canScrollForward
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    const viewport = tabViewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      const nextScrollLeft = resolveHorizontalWheelScroll({
        scrollLeft: viewport.scrollLeft,
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
      if (nextScrollLeft === null) return;
      event.preventDefault();
      viewport.scrollLeft = nextScrollLeft;
    };

    viewport.addEventListener("scroll", updateTabOverflow, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    const resizeObserver = new ResizeObserver(updateTabOverflow);
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild);
    updateTabOverflow();

    return () => {
      viewport.removeEventListener("scroll", updateTabOverflow);
      viewport.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
    };
  }, [props.surfaces.length, updateTabOverflow]);

  const focusTabSoon = useCallback((surfaceId: string) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.setTimeout(() => tabButtonRefs.current.get(surfaceId)?.focus(), 100);
      });
    });
  }, []);

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, surface: RightPanelSurface) => {
      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      if (
        event.altKey &&
        event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = surfaceIndex + (event.key === "ArrowLeft" ? -1 : 1);
        const target = props.surfaces[targetIndex];
        if (!target) return;
        props.onMoveSurface(surface.id, target.id);
        focusTabSoon(surface.id);
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (
        !(["ArrowLeft", "ArrowRight", "Home", "End"] as const).includes(
          event.key as TabNavigationKey,
        )
      ) {
        return;
      }
      const targetIndex = resolveTabNavigationIndex(
        event.key as TabNavigationKey,
        surfaceIndex,
        props.surfaces.length,
      );
      if (targetIndex === null) return;
      const target = props.surfaces[targetIndex];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      props.onActivate(target);
      focusTabSoon(target.id);
    },
    [focusTabSoon, props],
  );

  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      props.onMoveSurface(String(event.active.id), String(event.over.id));
    },
    [props],
  );

  const scrollTabs = useCallback((direction: -1 | 1) => {
    const viewport = tabViewportRef.current;
    if (!viewport) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(160, viewport.clientWidth * 0.7),
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, []);

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      items.push(
        { id: "move-left", label: "Move left", disabled: surfaceIndex === 0 },
        {
          id: "move-right",
          label: "Move right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "move-left": {
          const target = props.surfaces[surfaceIndex - 1];
          if (target) props.onMoveSurface(surface.id, target.id);
          break;
        }
        case "move-right": {
          const target = props.surfaces[surfaceIndex + 1];
          if (target) props.onMoveSurface(surface.id, target.id);
          break;
        }
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabViewportRef.current?.querySelector<HTMLElement>(
      "[data-active-tab='true']",
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "workspace-topbar gap-1 pl-2",
          !ownsDesktopTitleBar && "[--workspace-topbar-height:--spacing(11)]",
          props.mode === "inline" ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <DndContext
          sensors={tabSensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={handleTabDragEnd}
        >
          <ScrollArea
            viewportRef={tabViewportRef}
            hideScrollbars
            scrollFade
            className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
            data-right-panel-tab-list
          >
            <div
              className="flex h-full w-max min-w-full items-center gap-1"
              role="tablist"
              aria-label="Panel tabs"
              aria-orientation="horizontal"
            >
              <SortableContext
                items={props.surfaces.map((surface) => surface.id)}
                strategy={horizontalListSortingStrategy}
              >
                {props.surfaces.map((surface, index) => {
                  const active = surface.id === props.activeSurfaceId;
                  return (
                    <SortableSurfaceTab
                      key={surface.id}
                      surface={surface}
                      active={active}
                      pending={props.pendingSurfaceIds.has(surface.id)}
                      title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
                      tabIndex={active || (props.activeSurfaceId === null && index === 0) ? 0 : -1}
                      sessions={props.previewSessions}
                      theme={resolvedTheme}
                      onActivate={props.onActivate}
                      onClose={props.onCloseSurface}
                      onMouseDown={handleTabMouseDown}
                      onAuxClick={handleTabAuxClick}
                      onContextMenu={(event, targetSurface) =>
                        void handleTabContextMenu(event, targetSurface)
                      }
                      onKeyDown={handleTabKeyDown}
                      setButtonRef={setTabButtonRef}
                    />
                  );
                })}
              </SortableContext>
              {props.surfaces.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Add panel surface"
                  >
                    <Plus className="size-4" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
                    <SurfaceMenuItem
                      available={props.browserAvailable}
                      disabledReason={SURFACE_DISABLED_REASONS.browser}
                      onClick={props.onAddBrowser}
                    >
                      <Globe2 />
                      Browser
                    </SurfaceMenuItem>
                    <SurfaceMenuItem available onClick={props.onAddTerminal}>
                      <TerminalSquare />
                      Terminal
                    </SurfaceMenuItem>
                    <SurfaceMenuItem
                      available={props.filesAvailable}
                      disabledReason={SURFACE_DISABLED_REASONS.files}
                      onClick={props.onAddFiles}
                    >
                      <Files />
                      Files
                    </SurfaceMenuItem>
                    <SurfaceMenuItem
                      available={props.diffAvailable}
                      disabledReason={SURFACE_DISABLED_REASONS.diff}
                      onClick={props.onAddDiff}
                    >
                      <FileDiff />
                      Diff
                    </SurfaceMenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          </ScrollArea>
        </DndContext>
        {tabOverflow.hasOverflow ? (
          <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    aria-label="Scroll tabs left"
                    disabled={!tabOverflow.canScrollBack}
                    onClick={() => scrollTabs(-1)}
                  />
                }
              >
                <ChevronLeft className="size-4" />
              </TooltipTrigger>
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    aria-label="Scroll tabs right"
                    disabled={!tabOverflow.canScrollForward}
                    onClick={() => scrollTabs(1)}
                  />
                }
              >
                <ChevronRight className="size-4" />
              </TooltipTrigger>
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
