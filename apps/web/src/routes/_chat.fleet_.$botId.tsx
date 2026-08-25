import type { BotId } from "@shuv2code/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

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
 * The conversation route. The centre mounts `CaptainConversation` — the bubble
 * renderer, unconditionally, since M6's cutover.
 *
 * The header carries M2's identity controls (#197) — blob, inline rename, role
 * chip, and the gear that opens the identity sheet — plus the "Open in
 * workspace view" escape hatch. They arrive as one node through the shell's
 * `conversationHeaderActions` seam, so neither the shell nor this route knows
 * what is inside them.
 */
function BotConversationRouteView() {
  const { botId } = Route.useParams();
  // Keyed on the bot so the escape hatch is genuinely per-conversation: this
  // route component is reused across `$botId` changes, and without the key a
  // detour into workspace view for one bot would silently follow the captain
  // into the next conversation.
  return <BotConversationView botId={botId as BotId} key={botId} />;
}

function BotConversationView({ botId }: { readonly botId: BotId }) {
  const [workspaceView, setWorkspaceView] = useState(false);
  return (
    <CaptainShell
      activeBotId={botId}
      conversationHeaderActions={
        <>
          <CaptainConversationViewToggle
            onWorkspaceViewChange={setWorkspaceView}
            workspaceView={workspaceView}
          />
          <BotIdentityHeaderActions botId={botId} />
        </>
      }
      rightRail={<BotSidePanel botId={botId} />}
    >
      <CaptainConversation botId={botId} workspaceView={workspaceView} />
    </CaptainShell>
  );
}
