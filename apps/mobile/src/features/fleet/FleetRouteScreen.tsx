/**
 * Bot mode's index route. Additive: nothing about Home, threads or projects
 * changes, and the fleet is reached from the Home toolbar rather than by
 * restructuring anything.
 */
import { useNavigation } from "@react-navigation/native";
import type { ContactRailFilter } from "@shuv2code/client-runtime/ade/contact-rail";
import {
  applyContactRailFilter,
  getContactRowViews,
} from "@shuv2code/client-runtime/ade/contact-rail";
import type { BotId } from "@shuv2code/contracts";
import { useMemo, useState } from "react";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdeRoster } from "../../state/ade";
import { FleetFilterBar, FleetScreen } from "./FleetScreen";
import { useAdeEnvironmentId } from "./useAdeEnvironmentId";

export function FleetRouteScreen() {
  const navigation = useNavigation();
  const environmentId = useAdeEnvironmentId();
  const roster = useAdeRoster(environmentId);
  const [filter, setFilter] = useState<ContactRailFilter>("all");

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
      <FleetFilterBar attentionCount={attentionCount} filter={filter} onFilterChange={setFilter} />
      <FleetScreen
        error={roster.error}
        filter={filter}
        isPending={roster.isPending}
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
