import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotDetailPanel } from "../components/fleet/BotDetailPanel";

// `fleet_` opts out of nesting under the roster route, which renders a full
// page rather than an outlet.
export const Route = createFileRoute("/_chat/fleet_/$botId")({
  component: BotDetailRouteView,
});

function BotDetailRouteView() {
  const { botId } = Route.useParams();
  return <BotDetailPanel botId={botId as BotId} />;
}
