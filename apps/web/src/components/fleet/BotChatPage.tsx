import type { BotId, ScopedThreadRef, ThreadId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import {
  adeEnvironment,
  useAdeBotDetail,
  useAdeEnvironmentId,
  useAdeRoster,
} from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { BotChatConnectNoticeStrip, BotChatPendingConversation } from "./BotChatConnect";
import {
  BOT_CHAT_NO_PROJECT_ACTION,
  BOT_CHAT_NO_PROJECT_NOTICE,
  BOT_CHAT_TOOLS_MISSING_NOTICE,
  botChatStartNotice,
  getBotChatBody,
  getBotChatHeaderView,
  isBotChatComposerDisabled,
  resolveBotChatConnectState,
  resolveChatSyncOutcome,
  shouldAutoStartChat,
  shouldWarnToolsMissing,
  type BotChatConnectNotice,
} from "./BotChatPage.logic";
import { NeedsYouInline } from "./NeedsYouInline";
import { useBotChatRead } from "../captain/useBotChatRead";

/**
 * Firstmate/bot chat (spec §7 slice 1). The conversation itself is the
 * ordinary shuv2code stack — an ADE bot chat is an ordinary thread — wrapped
 * in a persona header strip.
 *
 * **Opening the conversation is the request to connect (M8, #217).** §4.1's
 * lazy-session rule used to read "on button press", which put a greeting, a
 * paragraph of kernel setup and a Start/Resume fork between the captain and
 * the bot. It now reads "on conversation open": this page starts the session
 * once per mount and renders the conversation shell throughout. The server is
 * already safe for that — `startPrimaryChat` takes a per-thread lock and gates
 * on `hasSession`, so an auto-start against a bot that is already live is a
 * probe-only pass that adopts the running session rather than tearing it down.
 *
 * §4.1's other half is unchanged: the app is never gated on kernels. A refusal
 * is a compact strip over the conversation, never a landing page, and the page
 * stays navigable.
 */
export function BotChatPage({
  botId,
  identityChrome = "own",
  renderConversation,
  conversationAtEnd,
}: {
  readonly botId: BotId;
  /**
   * Who prints the bot's name, role and project.
   *
   * `"own"` keeps this page's original header, for any surface that mounts it
   * bare. `"shell"` means the captain shell's conversation header is already
   * showing all of it a few pixels above (§2: one sticky 56px header with the
   * avatar, the name and the gear), so printing it again here is the same
   * three facts twice with two different affordances — one of them renameable,
   * one of them not. The live status line survives either way: it is the one
   * thing this header says that the identity header does not.
   */
  readonly identityChrome?: "own" | "shell";
  /**
   * M4's seam (MESSENGER-PIVOT §5 step 3). The connect/sync state machine and
   * the hook-count gate above are the *only* thing that knows when a bot
   * conversation is safe to mount, so the bubble renderer borrows them rather
   * than growing a second copy — and is called only in the `ready` state, so
   * neither it nor `ChatView` ever sees a thread the store has not got.
   * Absent — the default and the workspace-view escape hatch — the
   * conversation is `ChatView`, unchanged.
   */
  readonly renderConversation?: (args: {
    readonly threadRef: ScopedThreadRef;
    readonly threadSyncPhase: ReturnType<typeof resolveThreadSyncPhase>;
    readonly botName: string;
    /**
     * True when the thread is mountable but the session is not live — the
     * conversation region is reachable while a failure notice sits above it
     * (a bot whose detail read failed after the thread had already synced, for
     * instance). The timeline stays readable; only sending is shut off, so the
     * captain reads history instead of pressing send into a dead session.
     */
    readonly composerDisabled: boolean;
  }) => ReactNode;
  /**
   * The other half of M3's read signal, which M3 deliberately left for M4.
   *
   * A caller that renders its own conversation body also owns its scroll
   * position, so it can say whether the captain is actually at the bottom of
   * the thread. `undefined` — the `ChatView` path, whose at-end state stays
   * private to `components/chat/**` — keeps M3's focus-only behaviour.
   */
  readonly conversationAtEnd?: boolean;
}) {
  const environmentId = useAdeEnvironmentId();
  const detail = useAdeBotDetail(botId);
  const roster = useAdeRoster();
  const startChat = useAtomCommand(adeEnvironment.startBotChat, { reportFailure: false });
  const [startedThreadId, setStartedThreadId] = useState<ThreadId | null>(null);
  const [toolsMissing, setToolsMissing] = useState(false);
  /** When the current session was started, for the bounded sync fallback. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [syncElapsedMs, setSyncElapsedMs] = useState(0);
  const [startError, setStartError] = useState<BotChatConnectNotice | null>(null);

  const hasProjects = (roster.data?.projects.length ?? 0) > 0;
  const body = getBotChatBody({
    detail: detail.data,
    startedThreadId,
    loadError: detail.error ?? roster.error,
  });
  const header = detail.data === null ? null : getBotChatHeaderView(detail.data);
  // `body` is a discriminated union; JSX cannot narrow it across branches, so
  // the shape the rest of the render needs is pulled out here.
  const chatThreadId = body.kind === "chat" ? body.threadId : null;

  /**
   * ChatView must not be mounted until the client actually holds the thread.
   * Mounting it the instant `startBotChat` returns renders it once against a
   * thread the store has never seen and again once the subscription lands,
   * and its hook count differs between those two passes — React aborts the
   * subtree with "Rendered more hooks than during the previous render" and the
   * page goes blank. The real thread route gates on exactly this readiness,
   * so the ADE chat gates on it too rather than inventing a second rule.
   */
  const threadRef = useMemo(
    () =>
      chatThreadId === null || environmentId === null
        ? null
        : { environmentId, threadId: chatThreadId },
    [chatThreadId, environmentId],
  );
  const shell = useEnvironmentQuery(
    environmentId === null ? null : environmentShell.stateAtom(environmentId),
  );
  const threadShell = useThreadShell(threadRef);
  const threadDetail = useThreadDetail(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    serverThreadShellExists: threadShell !== null,
    serverThreadDetailExists: threadDetail !== null,
    serverThreadDetailDeleted: threadStatus === "deleted",
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: threadDetail !== null,
    shellExists: threadShell !== null,
    status: threadStatus,
  });
  // Tick only while waiting, so the bounded fallback can fire without making
  // the page re-render forever once it has settled.
  useEffect(() => {
    if (startedAt === null || threadDetail !== null) return;
    const timer = setInterval(() => setSyncElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [startedAt, threadDetail]);

  const syncOutcome =
    threadRef === null
      ? ({ kind: "waiting" } as const)
      : resolveChatSyncOutcome({
          renderState,
          threadShellExists: threadShell !== null,
          shellError: shell.error,
          elapsedMs: syncElapsedMs,
        });
  const chatReady = threadRef !== null && syncOutcome.kind === "ready";

  // Clearing this contact's unread dot (M3). Gated on `chatReady` rather than
  // on the route: a captain staring at a spinner has not read anything, and
  // marking on navigation alone would clear a count for a conversation that
  // never rendered. `conversationAtEnd` completes the signal wherever the
  // caller knows it: a captain scrolled far up a long thread is reading
  // history, not the tail.
  const rosterEntry = roster.data?.entries.find((entry) => entry.bot.id === botId);
  useBotChatRead({
    botId,
    enabled: chatReady && conversationAtEnd !== false,
    unreadCount: rosterEntry?.unreadCount ?? 0,
    lastMessageAt: rosterEntry?.lastMessage?.at ?? null,
  });

  const connectState = resolveBotChatConnectState({
    body,
    syncOutcome,
    startError,
    chatReady,
  });

  const handleStart = useCallback(async () => {
    if (environmentId === null) return;
    setStartError(null);
    const result = await startChat({ environmentId, input: { botId } });
    if (result._tag === "Failure") {
      // A kernel that cannot answer is reported here and nowhere else: the
      // page stays navigable, because the app is never gated on kernels.
      setStartError(botChatStartNotice(squashAtomCommandFailure(result)));
      return;
    }
    // Re-taken on every start, so an `unknown` probe (or a kernel upgraded
    // between visits) clears a strip a previous start put up.
    setToolsMissing(shouldWarnToolsMissing(result.value));
    setStartedAt(Date.now());
    setSyncElapsedMs(0);
    setStartedThreadId(result.value.threadId);
  }, [botId, environmentId, startChat]);

  /**
   * The direct connect (#217).
   *
   * The ref — not state — is what makes this safe under React's development
   * double-invoke of mount effects: it is written synchronously before the
   * `await`, so the second invocation sees the bot it just recorded and
   * `shouldAutoStartChat` returns false. State would not have committed yet and
   * both passes would fire. Keying it by `botId` rather than by a boolean lets
   * the same mount reconnect when the shell swaps conversations under it, which
   * is how the captain rail navigates.
   */
  const autoStartedFor = useRef<BotId | null>(null);
  useEffect(() => {
    if (
      !shouldAutoStartChat({
        botId,
        environmentReady: environmentId !== null,
        startedFor: autoStartedFor.current,
      })
    ) {
      return;
    }
    autoStartedFor.current = botId;
    void handleStart();
  }, [botId, environmentId, handleStart]);

  /**
   * Waiting must have an exit, and after #217 that exit is a Retry in the
   * notice rather than a return to a landing page. Clearing `startedThreadId`
   * drops the sync clock; re-running the start is safe because
   * `startPrimaryChat` adopts an existing session rather than buying a second.
   */
  const retryConnect = useCallback(() => {
    setStartedThreadId(null);
    setStartedAt(null);
    setSyncElapsedMs(0);
    setStartError(null);
    autoStartedFor.current = botId;
    void handleStart();
  }, [botId, handleStart]);

  return (
    <SidebarInset className="isolate flex h-dvh min-h-0 flex-col overflow-hidden overscroll-y-none bg-background text-foreground">
      <header
        className={cn(
          "flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2.5",
          // Nothing to say once the shell owns the identity line and no work is
          // running: an empty bordered strip is worse than no strip.
          identityChrome === "shell" &&
            (header === null || header.runningInstruction === null) &&
            "hidden",
        )}
      >
        {header === null ? (
          <Skeleton className="h-5 w-48" />
        ) : (
          <>
            <div
              className={cn(
                "flex flex-wrap items-center gap-2",
                identityChrome === "shell" && "hidden",
              )}
            >
              <Link
                className="truncate text-sm font-semibold"
                params={{ botId }}
                to="/fleet/$botId"
              >
                {header.name}
              </Link>
              <Badge size="sm" variant="outline">
                {header.roleLabel}
              </Badge>
              <Badge size="sm" variant="secondary">
                {header.roleTag}
              </Badge>
              <span className="truncate text-xs text-muted-foreground">{header.projectLabel}</span>
              {header.openAssignmentLabel === null ? null : (
                <span className="truncate text-xs text-muted-foreground">
                  · {header.openAssignmentLabel}
                </span>
              )}
            </div>
            {header.runningInstruction === null ? null : (
              <p className="truncate text-xs text-muted-foreground">
                Running: {header.runningInstruction}
              </p>
            )}
          </>
        )}
      </header>
      {/*
       * The inline half of UI slice 5. Same durable items as the inbox,
       * filtered to this bot; deciding here resolves the item the inbox lists.
       * `empty:hidden` keeps the strip from reserving space when nothing is
       * waiting, which is most of the time.
       */}
      <div className="shrink-0 px-4 pt-2 empty:hidden">
        <NeedsYouInline
          subject={{ botId }}
          variant={renderConversation === undefined ? "inline" : "bubble"}
        />
      </div>
      {/*
       * One conversation shell for all three connect states (#217). The strips
       * stack above it; what changes underneath is only whether the real
       * timeline or the pending stand-in is mounted.
       */}
      <div className="flex min-h-0 flex-1 flex-col">
        {connectState.kind === "failed" ? (
          <BotChatConnectNoticeStrip notice={connectState.notice} onRetry={retryConnect} />
        ) : null}
        {/*
         * A workspace with no project has nowhere for the bot to work. This is
         * a real precondition with a real next action, not conversation
         * narration, so it survives as a strip rather than as a paragraph.
         */}
        {!hasProjects && roster.data !== null ? (
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span>{BOT_CHAT_NO_PROJECT_NOTICE}</span>
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => openCommandPalette({ open: "add-project" })}
              size="sm"
              variant="outline"
            >
              {BOT_CHAT_NO_PROJECT_ACTION}
            </Button>
          </div>
        ) : null}
        {toolsMissing ? (
          // The conversation works; delegation does not. Saying so beats
          // letting the captain watch the bot fail to delegate silently.
          <BotChatConnectNoticeStrip notice={BOT_CHAT_TOOLS_MISSING_NOTICE} tone="muted" />
        ) : null}
        {chatReady && threadRef !== null ? (
          renderConversation === undefined ? (
            <ChatView
              environmentId={threadRef.environmentId}
              routeKind="server"
              threadId={threadRef.threadId}
              threadSyncPhase={threadSyncPhase}
            />
          ) : (
            renderConversation({
              threadRef,
              threadSyncPhase,
              botName: header?.name ?? "this bot",
              composerDisabled: isBotChatComposerDisabled(connectState),
            })
          )
        ) : (
          <BotChatPendingConversation
            botName={header?.name ?? "this bot"}
            shimmer={connectState.kind === "connecting"}
          />
        )}
      </div>
    </SidebarInset>
  );
}
