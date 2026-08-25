import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Retired (MESSENGER-PIVOT §5 step 4). The conversation lives at
 * `/fleet/$botId` inside the captain shell now; this route used to mount
 * `BotChatPage` bare, with no contacts rail and no shell chrome around it, so
 * anything still pointing here would drop the captain out of the messenger.
 * It stays as a redirect for one release rather than a 404 so bookmarks and
 * any link that has not been repointed still land in the right conversation.
 */
export const Route = createFileRoute("/_chat/fleet_/$botId_/chat")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/fleet/$botId", params: { botId: params.botId }, replace: true });
  },
});
