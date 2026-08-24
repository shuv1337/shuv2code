import type { BotId, ThreadId } from "@shuv2code/contracts";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { getBotChatBody, getBotChatHeaderView } from "./BotChatPage.logic";

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
      {chatThreadId !== null && environmentId !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatView environmentId={environmentId} routeKind="server" threadId={chatThreadId} />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
            {body.kind === "error" ? (
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
