/**
 * Bot mode's index route. Additive: nothing about Home, threads or projects
 * changes, and the fleet is reached from the Home toolbar rather than by
 * restructuring anything.
 */
import type { ContactRailFilter } from "@shuv2code/client-runtime/ade/contact-rail";
import {
  applyContactRailFilter,
  getContactRowViews,
} from "@shuv2code/client-runtime/ade/contact-rail";
import type { BotId } from "@shuv2code/contracts";
import { useMemo, useState } from "react";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdeFleetHealth, useAdeNeedsYouCount, useAdeRoster } from "../../state/ade";
import { FleetFilterBar, FleetScreen } from "./FleetScreen";
import { getKernelHealthAlertViews, kernelHealthAlertLine } from "./kernelHealth.logic";
import { KernelHealthAlertStrip } from "./KernelHealthPills";
import { useAdeEnvironmentId } from "./useAdeEnvironmentId";
import { useFleetNavigation } from "./fleetNavigation";

export function FleetRouteScreen() {
  const navigation = useFleetNavigation();
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster(environmentId);
  const needsYou = useAdeNeedsYouCount(environmentId);
  const fleetHealth = useAdeFleetHealth(environmentId);
  const [filter, setFilter] = useState<ContactRailFilter>("all");

  /*
   * Health interrupts the list only while something is actually down.
   * `not-provisioned` and `unknown` are dormancy and a probe that has not come
   * back — neither is news, and a strip that is present-but-fine on every
   * launch is a strip the captain learns to stop reading.
   */
  const healthAlerts = useMemo(() => getKernelHealthAlertViews(fleetHealth), [fleetHealth]);

  /*
   * The Attention count is derived from the same rows the filter applies to,
   * not from `ade.getNeedsYouCount`. The badge and the view it opens have to
   * agree, and a badge fed by a second read is how a captain ends up tapping
   * "3" and landing on an empty list.
   */
  const attentionCount = useMemo(
    () => applyContactRailFilter(getContactRowViews(roster.data), "attention").length,
    [roster.data],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ title: "Fleet" }} />
      <KernelHealthAlertStrip
        detail={healthAlerts[0]?.detail ?? null}
        line={kernelHealthAlertLine(healthAlerts)}
      />
      <FleetFilterBar
        attentionCount={attentionCount}
        filter={filter}
        needsYouCount={needsYou.data?.open ?? 0}
        onFilterChange={setFilter}
        onOpenNeedsYou={() => navigation.navigate("NeedsYou")}
      />
      <FleetScreen
        error={roster.error}
        filter={filter}
        isPending={roster.isPending}
        onOpenBotProfile={(botId: BotId) => {
          if (environmentId === null) return;
          navigation.navigate("BotProfile", {
            environmentId: String(environmentId),
            botId: String(botId),
          });
        }}
        onRefresh={roster.refresh}
        onSelectBot={(botId: BotId) => {
          if (environmentId === null) return;
          navigation.navigate("BotChat", {
            environmentId: String(environmentId),
            botId: String(botId),
          });
        }}
        roster={roster.data}
        searchQuery=""
      />
    </>
  );
}
