import type { BotId, ScopedThreadRef } from "@shuv2code/contracts";
import { MessageSquareIcon, PanelsTopLeftIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useThread } from "../../state/entities";
import { useAdeBotDetail, useAdeEnvironmentId, useAdeRoster } from "../../state/ade";
import { useUiStateStore } from "../../uiStateStore";
import { BotChatPage } from "../fleet/BotChatPage";
import { Button } from "../ui/button";
import { BubbleTimeline } from "./BubbleTimeline";
import { CaptainComposer } from "./CaptainComposer";
import { getBotAvatarView, type BotAvatarView } from "./contactRail.logic";

/**
 * The conversation region of the captain shell (MESSENGER-PIVOT §5 step 3).
 *
 * Two renderings of the same conversation, chosen by a per-session toggle that
 * defaults **off**:
 * - off — today's `BotChatPage` mounting `ChatView`, byte-identical to M1;
 * - on — `BubbleTimeline` + `CaptainComposer` over the *same* thread,
 *   with `BotChatPage` still owning start/sync so there is one state machine.
 *
 * The toggle is the escape hatch. While `classifyBubbleRow` and the `TraceCard`
 * seam are being tuned, a captain who hits something the bubble renderer folds
 * badly is one click from the workspace rendering, and does not have to leave
 * the conversation to get there. M6 removes both the toggle and this file's
 * branch.
 */
export function CaptainConversation({ botId }: { readonly botId: BotId }) {
  const bubbleView = useUiStateStore((state) => state.captainBubbleViewEnabled);
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

  if (!bubbleView || environmentId === null) {
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
 * The toggle itself, mounted into the shell's `conversationHeaderActions` seam
 * beside M2's identity controls. Labelled by destination rather than by state,
 * so pressing it says where it goes instead of what it currently is.
 */
export function CaptainConversationViewToggle() {
  const bubbleView = useUiStateStore((state) => state.captainBubbleViewEnabled);
  const setBubbleView = useUiStateStore((state) => state.setCaptainBubbleViewEnabled);
  return (
    <Button
      className="gap-1.5"
      onClick={() => setBubbleView(!bubbleView)}
      size="sm"
      title={bubbleView ? "Open in workspace view" : "Open in message view"}
      variant="ghost"
    >
      {bubbleView ? (
        <PanelsTopLeftIcon aria-hidden className="size-3.5" />
      ) : (
        <MessageSquareIcon aria-hidden className="size-3.5" />
      )}
      <span className="max-lg:sr-only">
        {bubbleView ? "Open in workspace view" : "Open in message view"}
      </span>
    </Button>
  );
}
