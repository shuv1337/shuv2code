import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

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
 */
function BotConversationRouteView() {
  const { botId } = Route.useParams();
  return (
    <CaptainShell activeBotId={botId as BotId}>
      <BotChatPage botId={botId as BotId} />
    </CaptainShell>
  );
}
