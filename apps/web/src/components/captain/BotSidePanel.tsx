import type { BotId } from "@shuv2code/contracts";
import { Link } from "@tanstack/react-router";
import { CpuIcon, NetworkIcon } from "lucide-react";
import { useMemo } from "react";

import { useAdeBotDetail } from "../../state/ade";
import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  BOT_MODEL_UNSUPPORTED_HINT,
  getBotModelLabel,
  getBotModelOptions,
  isFlaggedBotModel,
} from "./botModel.logic";
import { BotScreenPanel } from "./BotScreenPanel";
import { RoutinesPanel } from "./RoutinesPanel";

const NO_PROVIDERS: ReadonlyArray<never> = [];

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
  const providers = usePrimaryEnvironment()?.serverConfig?.providers ?? NO_PROVIDERS;
  const modelOptions = useMemo(() => getBotModelOptions(providers), [providers]);
  const modelSlug = detail.data?.modelSlug ?? null;

  return (
    <div className="flex min-h-0 flex-col">
      <BotScreenPanel botId={botId} botName={botName} />
      <RoutinesPanel botId={botId} botName={botName} />
      {/*
       * Which model this bot runs on, at a glance. It is here rather than only
       * behind the identity sheet because its absence is what made a bot stuck
       * on a tool-incapable model take hours to diagnose — nothing on any
       * surface said which model was answering. Editing stays in the sheet;
       * this is a fact, not a control.
       */}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        <CpuIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Model</span>
        <span className="min-w-0 flex-1 truncate text-right font-medium" title={modelSlug ?? ""}>
          {getBotModelLabel(modelOptions, modelSlug)}
        </span>
        {isFlaggedBotModel(modelOptions, modelSlug) ? (
          <Badge size="sm" variant="outline">
            {BOT_MODEL_UNSUPPORTED_HINT}
          </Badge>
        ) : null}
      </div>
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
