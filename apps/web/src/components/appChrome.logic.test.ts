/**
 * The regression this file exists for (#216): the coding interface is the app
 * default, and the one thing that must never happen while unifying the left
 * side is the workspace sidebar quietly disappearing from a route that is not
 * the captain shell. Asserted both ways.
 *
 * Every id below is written `satisfies AppRouteId`, which is the router's
 * generated union of real route ids. That is deliberate and is what keeps this
 * from being a test about strings: renaming or moving any of these route files
 * fails typecheck here — and in `appChrome.logic.ts`, whose list is typed the
 * same way — rather than silently restoring, or silently spreading, the
 * duelling sidebars. The route modules themselves are not imported because
 * several of them reach a bundler-only worker import.
 */
import { describe, expect, it } from "vite-plus/test";

import { CAPTAIN_SHELL_ROUTE_IDS, hidesWorkspaceSidebar, type AppRouteId } from "./appChrome.logic";

/** The stack `useMatches` reports for a route nested under `/_chat`. */
const chatStack = (leaf: string): ReadonlyArray<string> => ["__root__", "/_chat", leaf];

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId" satisfies AppRouteId;
const CHAT_INDEX_ROUTE_ID = "/_chat/" satisfies AppRouteId;
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId" satisfies AppRouteId;
const PULL_REQUESTS_ROUTE_ID = "/_chat/pull-requests" satisfies AppRouteId;
const SETTINGS_ROUTE_ID = "/settings" satisfies AppRouteId;
const USAGE_ROUTE_ID = "/usage" satisfies AppRouteId;

const FLEET_INDEX_ROUTE_ID = "/_chat/fleet" satisfies AppRouteId;
const BOT_CONVERSATION_ROUTE_ID = "/_chat/fleet_/$botId" satisfies AppRouteId;
const FLEET_WORK_ROUTE_ID = "/_chat/fleet_/work" satisfies AppRouteId;
const FLEET_PROJECT_ROUTE_ID = "/_chat/fleet_/projects_/$adeProjectId" satisfies AppRouteId;

describe("hidesWorkspaceSidebar", () => {
  it("keeps the workspace sidebar on the coding interface", () => {
    // The non-negotiable half. A thread is the app's default surface; nothing
    // in #216 may touch it.
    for (const routeId of [
      THREAD_ROUTE_ID,
      CHAT_INDEX_ROUTE_ID,
      DRAFT_ROUTE_ID,
      PULL_REQUESTS_ROUTE_ID,
      USAGE_ROUTE_ID,
    ]) {
      expect(hidesWorkspaceSidebar(chatStack(routeId))).toBe(false);
    }
    expect(hidesWorkspaceSidebar(["__root__", SETTINGS_ROUTE_ID])).toBe(false);
  });

  it("drops it on the captain shell routes, which render their own rail", () => {
    expect(hidesWorkspaceSidebar(chatStack(FLEET_INDEX_ROUTE_ID))).toBe(true);
    expect(hidesWorkspaceSidebar(chatStack(BOT_CONVERSATION_ROUTE_ID))).toBe(true);
  });

  it("keeps it on the fleet pages that have no rail of their own", () => {
    // `/fleet/work` and `/fleet/projects/$id` are full analysis surfaces
    // (MESSENGER-PIVOT §5.4) reached *from* the rail, not built on it. A
    // pathname prefix would have swept them up and left them with no left
    // navigation at all — which is why the decision is made from route ids.
    expect(hidesWorkspaceSidebar(chatStack(FLEET_WORK_ROUTE_ID))).toBe(false);
    expect(hidesWorkspaceSidebar(chatStack(FLEET_PROJECT_ROUTE_ID))).toBe(false);
  });

  it("names exactly the two shell routes", () => {
    expect([...CAPTAIN_SHELL_ROUTE_IDS].toSorted()).toEqual(
      [FLEET_INDEX_ROUTE_ID, BOT_CONVERSATION_ROUTE_ID].toSorted(),
    );
  });

  it("reports no rail for an empty match stack", () => {
    expect(hidesWorkspaceSidebar([])).toBe(false);
  });
});
