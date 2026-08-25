import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotIdentityHeaderActions } from "../components/captain/BotIdentityHeaderActions";
import { CaptainShell } from "../components/captain/CaptainShell";
import { BotChatPage } from "../components/fleet/BotChatPage";

// `fleet_` opts out of nesting under the index route, which renders the shell
// itself rather than an outlet.
export const Route = createFileRoute("/_chat/fleet_/$botId")({
  component: BotConversationRouteView,
});

/**
 * The conversation route (§5 step 1). The centre mounts today's `BotChatPage`
 * unchanged — its lazy-start state machine and its hook-count gate move in as
 * they are — so the messenger is usable before any backend delta or the M4
 * bubble renderer lands.
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
      conversationHeaderActions={<BotIdentityHeaderActions botId={botId as BotId} />}
    >
      <BotChatPage botId={botId as BotId} />
    </CaptainShell>
  );
}
