import type { BotId, ScopedThreadRef } from "@shuv2code/contracts";
import { MessageSquareIcon, PanelsTopLeftIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useThread } from "../../state/entities";
import { useAdeBotDetail, useAdeEnvironmentId, useAdeRoster } from "../../state/ade";
import { BotChatPage } from "../fleet/BotChatPage";
import { Button } from "../ui/button";
import { BubbleTimeline } from "./BubbleTimeline";
import { CaptainComposer } from "./CaptainComposer";
import { getBotAvatarView, type BotAvatarView } from "./contactRail.logic";

/**
 * The conversation region of the captain shell (MESSENGER-PIVOT §5 step 5 —
 * the cutover).
 *
 * **The bubble renderer is the conversation.** For one release it sat behind a
 * per-session toggle that defaulted off while `classifyBubbleRow` and the
 * `TraceCard` seam were tuned; that gate is gone, along with the store field
 * that held it. The precondition the design set for removing it — a test per
 * arm of `MessagesTimelineRow` plus a default-to-trace assertion — is met and
 * pinned by an exhaustiveness check in `MessagesTimeline.logic.test.ts`, so an
 * added row kind fails a test rather than reaching a captain as a blank bubble.
 *
 * **The escape hatch stays, and stops being a gate.** "Open in workspace view"
 * still mounts today's `BotChatPage`/`ChatView` for the same thread, because
 * some turns are genuinely easier to read with the IDE's chrome. What changed
 * is its shape: it is per-mount React state, not persisted preference. A
 * captain who opens it for one turn gets the messenger back at the next
 * conversation, rather than latching a default-off months ago and later
 * reporting the messenger's arrival as a regression.
 *
 * `BotChatPage` still owns start/sync and the hook-count gate on both sides, so
 * there remains exactly one session state machine.
 */
export function CaptainConversation({
  botId,
  workspaceView,
}: {
  readonly botId: BotId;
  /**
   * The escape hatch, owned by the route so the affordance can live in the
   * shell's header beside the identity controls. Per-conversation, not
   * persisted (see above).
   */
  readonly workspaceView: boolean;
}) {
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster();
  const detail = useAdeBotDetail(botId);

  const entries = roster.data?.entries;

  const botNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries ?? []) {
      map.set(entry.bot.id, entry.bot.name);
    }
    return map;
  }, [entries]);

  const avatarByBotId = useMemo(() => {
    const map = new Map<string, BotAvatarView>();
    for (const entry of entries ?? []) {
      map.set(
        entry.bot.id,
        getBotAvatarView({
          botId: entry.bot.id,
          name: entry.bot.name,
          displayMeta: entry.bot.displayMeta,
        }),
      );
    }
    return map;
  }, [entries]);

  const botAvatar = avatarByBotId.get(botId) ?? null;

  /**
   * The at-end half of M3's read signal, held here because `BotChatPage` owns
   * `useBotChatRead` and the timeline that knows the answer is mounted
   * *inside* it. M3 reserved this for M4 by name; on the workspace-view side
   * the prop stays absent, so `ChatView`'s private at-end state does not have
   * to be threaded out of `components/chat/**`.
   */
  const [isAtEnd, setIsAtEnd] = useState(true);

  /*
   * `environmentId === null` still falls back to the workspace rendering, and
   * that is not a leftover of the toggle: `BubbleTimeline` and
   * `CaptainComposer` are both scoped to an environment, so with none resolved
   * there is nothing for them to read. `BotChatPage` handles the unresolved
   * case on its own, so the captain sees its loading state rather than an
   * empty messenger.
   */
  if (workspaceView || environmentId === null) {
    return <BotChatPage botId={botId} identityChrome="shell" />;
  }

  return (
    <BotChatPage
      botId={botId}
      conversationAtEnd={isAtEnd}
      identityChrome="shell"
      renderConversation={({ threadRef, botName }) => (
        <CaptainConversationBody
          avatarByBotId={avatarByBotId}
          botAvatar={botAvatar}
          botName={detail.data?.bot.name ?? botName}
          botNameById={botNameById}
          onIsAtEndChange={setIsAtEnd}
          threadRef={threadRef}
        />
      )}
    />
  );
}

function CaptainConversationBody({
  threadRef,
  botName,
  botAvatar,
  botNameById,
  avatarByBotId,
  onIsAtEndChange,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly botName: string;
  readonly botAvatar: BotAvatarView | null;
  readonly botNameById: ReadonlyMap<string, string>;
  readonly avatarByBotId: ReadonlyMap<string, BotAvatarView>;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
}) {
  const thread = useThread(threadRef);
  const isWorking = thread?.session?.status === "running";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <BubbleTimeline
          avatarByBotId={avatarByBotId}
          botAvatar={botAvatar}
          botNameById={botNameById}
          environmentId={threadRef.environmentId}
          isWorking={isWorking}
          onIsAtEndChange={onIsAtEndChange}
          thread={thread}
          threadRef={threadRef}
        />
      </div>
      <CaptainComposer
        botName={botName}
        environmentId={threadRef.environmentId}
        thread={thread}
        threadRef={threadRef}
      />
    </div>
  );
}

/**
 * The escape hatch, mounted into the shell's `conversationHeaderActions` seam
 * beside M2's identity controls.
 *
 * Still labelled by destination rather than by state, so pressing it says where
 * it goes instead of what it currently is — and it is now a *detour* rather
 * than a mode: the state it flips lives for one conversation, so the way back
 * is always the messenger.
 */
export function CaptainConversationViewToggle({
  workspaceView,
  onWorkspaceViewChange,
}: {
  readonly workspaceView: boolean;
  readonly onWorkspaceViewChange: (next: boolean) => void;
}) {
  return (
    <Button
      className="gap-1.5"
      onClick={() => onWorkspaceViewChange(!workspaceView)}
      size="sm"
      title={workspaceView ? "Open in message view" : "Open in workspace view"}
      variant="ghost"
    >
      {workspaceView ? (
        <MessageSquareIcon aria-hidden className="size-3.5" />
      ) : (
        <PanelsTopLeftIcon aria-hidden className="size-3.5" />
      )}
      <span className="max-lg:sr-only">
        {workspaceView ? "Open in message view" : "Open in workspace view"}
      </span>
    </Button>
  );
}
