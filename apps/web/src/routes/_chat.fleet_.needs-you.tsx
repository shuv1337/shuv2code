import { createFileRoute } from "@tanstack/react-router";

import { NeedsYouInboxPage } from "../components/fleet/NeedsYouInboxPage";

export const Route = createFileRoute("/_chat/fleet_/needs-you")({
  component: NeedsYouInboxPage,
});
