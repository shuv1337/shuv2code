import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotIdentityHeaderActions } from "../components/captain/BotIdentityHeaderActions";
import {
  CaptainConversation,
  CaptainConversationViewToggle,
} from "../components/captain/CaptainConversation";
import { BotSidePanel } from "../components/captain/BotSidePanel";
import { CaptainShell } from "../components/captain/CaptainShell";

// `fleet_` opts out of nesting under the index route, which renders the shell
// itself rather than an outlet.
export const Route = createFileRoute("/_chat/fleet_/$botId")({
  component: BotConversationRouteView,
});

/**
 * The conversation route. The centre mounts `CaptainConversation`, which is
 * today's `BotChatPage` (its lazy-start state machine and hook-count gate
 * unchanged) until the per-session M4 toggle selects the bubble renderer over
 * the same thread. Default off; the header carries the switch both ways.
 *
 * The header carries M2's identity controls (#197): blob, inline rename, role
 * chip, and the gear that opens the identity sheet. They arrive as one node
 * through the shell's `conversationHeaderActions` seam, so neither the shell
 * nor this route knows what is inside them.
 */
function BotConversationRouteView() {
  const { botId } = Route.useParams();
  return (
    <CaptainShell
      activeBotId={botId as BotId}
      conversationHeaderActions={
        <>
          <CaptainConversationViewToggle />
          <BotIdentityHeaderActions botId={botId as BotId} />
        </>
      }
      rightRail={<BotSidePanel botId={botId as BotId} />}
    >
      <CaptainConversation botId={botId as BotId} />
    </CaptainShell>
  );
}
