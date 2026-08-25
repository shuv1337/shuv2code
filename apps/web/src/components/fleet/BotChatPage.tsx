import type { BotId, ThreadId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import {
  adeEnvironment,
  useAdeBotDetail,
  useAdeEnvironmentId,
  useAdeRoster,
} from "../../state/ade";
import { adeCaptainErrorMessage } from "../../state/ade.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  getBotChatBody,
  getBotChatHeaderView,
  resolveChatSyncOutcome,
  shouldWarnToolsMissing,
} from "./BotChatPage.logic";
import { NeedsYouInline } from "./NeedsYouInline";
import { useBotChatRead } from "../captain/useBotChatRead";

/**
 * Firstmate/bot chat (spec §7 slice 1). The conversation itself is the
 * ordinary shuv2code stack — an ADE bot chat is an ordinary thread — wrapped
 * in a persona header strip. No kernel session is started on mount (§4.1);
 * that only happens when the captain presses the button.
 */
export function BotChatPage({ botId }: { readonly botId: BotId }) {
  const environmentId = useAdeEnvironmentId();
  const detail = useAdeBotDetail(botId);
  const roster = useAdeRoster();
  const startChat = useAtomCommand(adeEnvironment.startBotChat, { reportFailure: false });
  const [startedThreadId, setStartedThreadId] = useState<ThreadId | null>(null);
  const [toolsMissing, setToolsMissing] = useState(false);
  /** When the current session was started, for the bounded sync fallback. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [syncElapsedMs, setSyncElapsedMs] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = getBotChatBody({
    detail: detail.data,
    startedThreadId,
    hasProjects: (roster.data?.projects.length ?? 0) > 0,
    loadError: detail.error ?? roster.error,
  });
  const header = detail.data === null ? null : getBotChatHeaderView(detail.data);
  // `body` is a discriminated union; JSX cannot narrow it across branches, so
  // the two shapes are pulled out here.
  const chatThreadId = body.kind === "chat" ? body.threadId : null;
  const welcome = body.kind === "welcome" ? body.copy : null;

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
  // never rendered.
  useBotChatRead({
    botId,
    enabled: chatReady,
    lastMessageAt:
      roster.data?.entries.find((entry) => entry.bot.id === botId)?.lastMessage?.at ?? null,
  });

  const retrySync = () => {
    // Waiting must have an exit. Drop back to the welcome state so the captain
    // gets a button instead of a spinner; `startBotChat` is idempotent, so
    // pressing it re-adopts the existing session rather than buying a second.
    setStartedThreadId(null);
    setStartedAt(null);
    setSyncElapsedMs(0);
    setError(syncOutcome.kind === "retry" ? syncOutcome.message : null);
  };

  const handleStart = async () => {
    if (environmentId === null) return;
    setStarting(true);
    setError(null);
    const result = await startChat({ environmentId, input: { botId } });
    setStarting(false);
    if (result._tag === "Failure") {
      // A kernel that cannot answer is reported here and nowhere else: the
      // page stays navigable, because the app is never gated on kernels.
      setError(
        adeCaptainErrorMessage(
          squashAtomCommandFailure(result),
          "This bot's session could not be started.",
        ),
      );
      return;
    }
    // Re-taken on every start, so an `unknown` probe (or a kernel upgraded
    // between visits) clears a strip a previous start put up.
    setToolsMissing(shouldWarnToolsMissing(result.value));
    setStartedAt(Date.now());
    setSyncElapsedMs(0);
    setStartedThreadId(result.value.threadId);
  };

  return (
    <SidebarInset className="isolate flex h-dvh min-h-0 flex-col overflow-hidden overscroll-y-none bg-background text-foreground">
      <header className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2.5">
        {header === null ? (
          <Skeleton className="h-5 w-48" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
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
        <NeedsYouInline subject={{ botId }} />
      </div>
      {chatReady && threadRef !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {toolsMissing ? (
            // The conversation works; delegation does not. Saying so beats
            // letting the captain watch the bot fail to delegate silently.
            //
            // NOTE: a *start-time snapshot*. It reflects what the catalog
            // probe saw when the session was opened and is never re-checked, so
            // a kernel upgraded mid-session keeps showing this until reopened.
            <p
              className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
              role="status"
            >
              Fleet tools are not available on this kernel build, so this bot cannot delegate
              assignments or update its memory. Chat still works.
            </p>
          ) : null}
          <ChatView
            environmentId={threadRef.environmentId}
            routeKind="server"
            threadId={threadRef.threadId}
            threadSyncPhase={threadSyncPhase}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
            {body.kind === "chat" && syncOutcome.kind === "retry" ? (
              // This bot already owns a live kernel session, so a permanent
              // spinner would strand the captain with no way back to Start.
              <>
                <p className="text-sm text-destructive" role="alert">
                  {syncOutcome.message}
                </p>
                <Button className="self-start" onClick={retrySync} size="sm">
                  Try again
                </Button>
              </>
            ) : body.kind === "chat" ? (
              // A session exists; the client is still catching up on the
              // thread. Showing the welcome again here would invite a second
              // "Start chatting" press on a bot that already has a session.
              <>
                <p className="text-sm text-muted-foreground">Opening the conversation…</p>
                <Skeleton className="h-20 w-full" />
              </>
            ) : body.kind === "error" ? (
              <p className="text-sm text-destructive">{body.message}</p>
            ) : welcome === null ? (
              <>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-20 w-full" />
              </>
            ) : (
              <>
                <p className="text-base">{welcome.greeting}</p>
                {welcome.projectCta === null ? null : (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-muted-foreground">{welcome.projectCta}</p>
                    <Button
                      onClick={() => openCommandPalette({ open: "add-project" })}
                      size="sm"
                      variant="outline"
                    >
                      Create your first project
                    </Button>
                  </div>
                )}
                <p className="text-sm text-muted-foreground">{welcome.kernelHint}</p>
                <Button
                  className={cn("self-start")}
                  disabled={starting || environmentId === null}
                  onClick={() => void handleStart()}
                >
                  {welcome.startLabel}
                </Button>
                {error === null ? null : (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </SidebarInset>
  );
}
