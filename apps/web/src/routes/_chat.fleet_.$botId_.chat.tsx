import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotChatPage } from "../components/fleet/BotChatPage";

// Both `fleet_` and `$botId_` opt out of nesting: the roster and the detail
// panel are full pages, not layouts with outlets.
export const Route = createFileRoute("/_chat/fleet_/$botId_/chat")({
  component: BotChatRouteView,
});

function BotChatRouteView() {
  const { botId } = Route.useParams();
  return <BotChatPage botId={botId as BotId} />;
}
