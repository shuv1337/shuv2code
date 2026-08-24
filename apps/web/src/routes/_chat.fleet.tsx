import { createFileRoute } from "@tanstack/react-router";

import { FleetRosterPage } from "../components/fleet/FleetRosterPage";

export const Route = createFileRoute("/_chat/fleet")({
  component: FleetRosterPage,
});
