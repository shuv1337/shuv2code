import type { BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { useAdeBotDetail } from "../../state/ade";
import { Button } from "../ui/button";
import { BotScreenPanel } from "./BotScreenPanel";
import { RoutinesPanel } from "./RoutinesPanel";

/**
 * The right rail's contents (MESSENGER-PIVOT §2, M6): screen thumbnail, then
 * Routines, then a collapsed Work section that links into the existing work
 * graph.
 *
 * The shell owns the region — width, overlay, sheet, resize — and this owns
 * what is inside it. That split is why M6 could supply the rail without
 * touching the geometry M1 tested.
 *
 * Work stays a *link*, not an embed. `/fleet/work` and
 * `/fleet/projects/$adeProjectId` survive as full analysis pages precisely
 * because they are deliberately out of messenger scope (§5 step 4); pulling a
 * graph into 470px would recreate the IDE chrome the pivot removed.
 */
export function BotSidePanel({ botId }: { readonly botId: BotId }) {
  const detail = useAdeBotDetail(botId);
  const botName = detail.data?.bot.name ?? "Bot";

  return (
    <div className="flex min-h-0 flex-col">
      <BotScreenPanel botId={botId} botName={botName} />
      <RoutinesPanel botId={botId} botName={botName} />
      <div className="border-t border-border p-3">
        <Button
          className="w-full justify-start"
          render={<Link to="/fleet/work" />}
          size="sm"
          variant="ghost"
        >
          <NetworkIcon aria-hidden />
          Work graph
        </Button>
      </div>
    </div>
  );
}
