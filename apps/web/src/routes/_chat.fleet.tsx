import { createFileRoute } from "@tanstack/react-router";

import { CaptainIndexPane } from "../components/captain/CaptainIndexPane";
import { CaptainShell } from "../components/captain/CaptainShell";

export const Route = createFileRoute("/_chat/fleet")({
  component: CaptainIndexRouteView,
});

/** The messenger index: the rail, and a conversation region with no contact. */
function CaptainIndexRouteView() {
  return (
    <CaptainShell activeBotId={null}>
      <CaptainIndexPane />
    </CaptainShell>
  );
}
