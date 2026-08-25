import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { CaptainIndexPane } from "../components/captain/CaptainIndexPane";
import { CaptainShell } from "../components/captain/CaptainShell";
import {
  parseContactRailFilter,
  type ContactRailFilter,
} from "../components/captain/contactRail.logic";

export interface FleetSearch {
  /**
   * Absent rather than `"all"` for the default view. Two reasons, both about
   * call sites rather than about this file: a required key would force every
   * existing `to: "/fleet"` link in the app to name a filter it does not care
   * about, and `/fleet?filter=all` is a URL that says nothing while looking
   * like it says something.
   */
  readonly filter?: "attention";
}

export const Route = createFileRoute("/_chat/fleet")({
  /**
   * `?filter=attention` is what retires `/fleet/needs-you` (§5.4). It lives in
   * the URL rather than in component state because it is a *destination*: the
   * sidebar's Needs You badge links to it, the old inbox route redirects into
   * it, and both of those need the view to survive a reload and a back button.
   *
   * Narrowed by hand rather than decoded, matching `/pull-requests`: an unknown
   * value falls back to the whole fleet instead of erroring, because a deep
   * link with a stale query string should still show the captain their bots.
   */
  validateSearch: (raw: Record<string, unknown>): FleetSearch =>
    parseContactRailFilter(raw.filter) === "attention" ? { filter: "attention" } : {},
  component: CaptainIndexRouteView,
});

/** The messenger index: the rail, and a conversation region with no contact. */
function CaptainIndexRouteView() {
  const search = Route.useSearch();
  const filter = parseContactRailFilter(search.filter);
  const navigate = useNavigate();

  const onRailFilterChange = useCallback(
    (next: ContactRailFilter) => {
      // `replace` so flipping between All and Attention does not build a stack
      // of history entries the back button has to walk through to leave the
      // rail — the view is a lens on one page, not a sequence of pages.
      void navigate({
        to: "/fleet",
        search: next === "attention" ? { filter: "attention" } : {},
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <CaptainShell activeBotId={null} onRailFilterChange={onRailFilterChange} railFilter={filter}>
      <CaptainIndexPane filter={filter} />
    </CaptainShell>
  );
}
