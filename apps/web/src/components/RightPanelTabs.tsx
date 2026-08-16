import type {
  ContextMenuItem,
  PreviewSessionSnapshot,
  PullRequestState,
} from "@shuv2code/contracts";
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
  Bot,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  MicIcon,
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
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import {
  resolveHorizontalWheelScroll,
  resolveTabNavigationIndex,
  type TabNavigationKey,
} from "./rightPanelTabStrip";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId?: Readonly<Record<string, DesktopPreviewOverlay>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface: (surfaceId: string, targetSurfaceId: string) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddVoice?: () => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>>;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the shuv2code desktop app.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  agents: "Agents are only available from a thread.",
} as const;

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

/** One-line unavailability hints for the empty-state cards. */
const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "No pull request on this branch yet.",
  agents: "Available from a thread.",
  voice: "Available from a thread.",
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

/**
 * Card launcher shown when the right panel has no surfaces. Keyboard-first
 * without palette chrome: a surface's letter opens it directly from anywhere
 * outside a typing context, and arrows plus Enter work while the launcher is
 * focused. The highlight only appears on hover or arrow use. Unavailable
 * surfaces stay visible with a one-line reason.
 */
function RightPanelEmptyState(props: {
  onAddVoice?: () => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
}) {
  // -1 means no highlight: it only appears on hover or arrow use.
  const [highlight, setHighlight] = useState(-1);

  const actions = [
    {
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.browser,
      onClick: props.onAddBrowser,
      badgeCount: 0,
    },
    {
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.terminal,
      onClick: props.onAddTerminal,
      badgeCount: 0,
    },
    {
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      label: "Pull request",
      description: "Open this branch's pull request.",
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
      badgeCount: 0,
    },
    {
      label: "Agents",
      description: "Follow subagents and workflows.",
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.agents,
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
    {
      label: "Voice",
      description: "Open the persistent environment voice thread.",
      icon: MicIcon,
      shortcut: "V",
      available: props.onAddVoice !== undefined,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.voice,
      onClick: () => props.onAddVoice?.(),
      badgeCount: 0,
    },
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  // Letter shortcuts work while the launcher is visible, not only while it
  // is focused; focus moves around too easily (stray clicks) to carry them.
  // Capture phase so app-level key handlers cannot swallow the event first;
  // typing contexts and already-handled events are left alone.
  const shortcutActionsRef = useRef(availableActions);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest("input, textarea, select")) return;
        // An empty contenteditable (the chat composer at rest) does not
        // count as typing; letters only become text once a draft exists.
        const editable = target.isContentEditable ? target : target.closest("[contenteditable]");
        if (editable && (editable.textContent ?? "").trim().length > 0) return;
      }
      const action = shortcutActionsRef.current.find(
        (candidate) => candidate.shortcut.toLowerCase() === event.key.toLowerCase(),
      );
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      // A focused card button owns its own activation; only open from the
      // highlight when the container itself has focus.
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
        {action.badgeCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
          >
            {action.badgeCount}
          </span>
        ) : null}
      </span>
    );
  };

  const cardShellClass =
    "rounded-lg border border-border/80 bg-card dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5";
  const highlightedCardClass = "bg-accent/60 dark:inset-ring-white/20";

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        // The panel topbar sits above this container; matching bottom padding
        // keeps the cards centered against the full panel, not the leftover.
        "pb-[calc(var(--workspace-topbar-height)+--spacing(6))]",
      )}
    >
      <div className="relative w-full max-w-lg">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">Open a surface</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
                className={cn(
                  "relative flex w-full cursor-pointer flex-col items-start p-4 text-left transition hover:border-border hover:bg-accent/60",
                  cardShellClass,
                  isHighlighted(action) && highlightedCardClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.description}
                </span>
              </button>
            ) : (
              <div
                key={action.label}
                className={cn(
                  "relative flex w-full flex-col items-start p-4 opacity-40",
                  cardShellClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.disabledReason}
                </span>
              </div>
            ),
          )}
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
    case "voice":
      return "Voice";
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
    case "pull-request":
      return `#${surface.number}`;
    case "agents":
      return "Agents";
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

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
  pullRequestStatuses,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId?: Readonly<Record<string, DesktopPreviewOverlay>> | undefined;
  theme: "light" | "dark";
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  switch (surface.kind) {
    case "voice":
      return <MicIcon className="size-3.5 shrink-0" />;
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      const favicon = snapshot ? (desktopByTabId?.[snapshot.tabId]?.favicon ?? null) : null;
      const capturedUrl =
        favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request": {
      const status = pullRequestStatuses?.[surface.id] ?? null;
      const toneClassName =
        status?.state === "merged"
          ? "text-violet-600 dark:text-violet-300/90"
          : status?.state === "closed"
            ? "text-red-600 dark:text-red-300/90"
            : status?.isDraft
              ? "text-zinc-500 dark:text-zinc-400/80"
              : status?.state === "open"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-muted-foreground";
      return <GitPullRequest className={cn("size-3 shrink-0", toneClassName)} />;
    }
    case "agents":
      return <Bot className="size-3 shrink-0" />;
  }
}

interface SortableSurfaceTabProps {
  surface: RightPanelSurface;
  active: boolean;
  pending: boolean;
  title: string;
  tabIndex: number;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId?: Readonly<Record<string, DesktopPreviewOverlay>> | undefined;
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>> | undefined;
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
    useSortable({ id: props.surface.id, disabled: props.surface.kind === "voice" });
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
              {...(props.surface.kind === "voice" ? {} : listeners)}
              type="button"
              role="tab"
              aria-selected={props.active}
              {...(props.surface.kind === "voice"
                ? {}
                : {
                    "aria-roledescription": "sortable tab",
                    "aria-keyshortcuts": "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight",
                  })}
              tabIndex={props.tabIndex}
              className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
              onClick={() => props.onActivate(props.surface)}
              onKeyDown={(event) => props.onKeyDown(event, props.surface)}
            >
              <SurfaceIcon
                surface={props.surface}
                sessions={props.sessions}
                desktopByTabId={props.desktopByTabId}
                theme={props.theme}
                pullRequestStatuses={props.pullRequestStatuses}
              />
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
        if (surface.kind === "voice") return;
        const targetIndex = surfaceIndex + (event.key === "ArrowLeft" ? -1 : 1);
        const target = props.surfaces[targetIndex];
        if (!target || target.kind === "voice") return;
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
      if (surface.kind !== "voice") {
        items.push(
          {
            id: "move-left",
            label: "Move left",
            disabled: surfaceIndex === 0 || props.surfaces[surfaceIndex - 1]?.kind === "voice",
          },
          {
            id: "move-right",
            label: "Move right",
            disabled: surfaceIndex >= props.surfaces.length - 1,
          },
        );
      }
      items.push(
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
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its tab bar keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
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
            chainVerticalScroll
            className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
            data-right-panel-tab-list
          >
            <div className="flex h-full w-max min-w-full items-center gap-1">
              <div
                className="flex h-full items-center gap-1"
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
                        title={surfaceTitle(
                          surface,
                          props.previewSessions,
                          props.terminalLabelsById,
                        )}
                        tabIndex={
                          active || (props.activeSurfaceId === null && index === 0) ? 0 : -1
                        }
                        sessions={props.previewSessions}
                        desktopByTabId={props.desktopByTabId}
                        pullRequestStatuses={props.pullRequestStatuses}
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
              </div>
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
                      available={props.onAddVoice !== undefined}
                      disabledReason={SURFACE_UNAVAILABLE_HINTS.voice}
                      onClick={() => props.onAddVoice?.()}
                    >
                      <MicIcon />
                      Voice
                    </SurfaceMenuItem>
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
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            {...(props.onAddVoice === undefined ? {} : { onAddVoice: props.onAddVoice })}
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddAgents={props.onAddAgents}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            agentsAvailable={props.agentsAvailable}
            liveAgentCount={props.liveAgentCount}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
