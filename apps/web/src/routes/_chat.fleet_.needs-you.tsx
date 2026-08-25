import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Retired (MESSENGER-PIVOT §5 step 4, ticket M3).
 *
 * The Needs You inbox was a second page listing the same bots the contact rail
 * already lists, which is what made "one durable item, two renderings" turn
 * into two places to look. It is a *view* of the rail now — `?filter=attention`
 * — so the captain answers a decision without leaving the messenger and
 * without losing the conversation it belongs to.
 *
 * A redirect rather than a 404 for one release: the sidebar badge, any
 * bookmark, and anything a bot has written down still land somewhere that
 * answers the question they were asking. `replace` keeps the dead route out of
 * the history stack, so Back goes where the captain came from rather than
 * bouncing them through the redirect again.
 */
export const Route = createFileRoute("/_chat/fleet_/needs-you")({
  beforeLoad: () => {
    throw redirect({ to: "/fleet", search: { filter: "attention" }, replace: true });
  },
});
