/**
 * The Needs You inbox on a phone (spec §7 slice 5).
 *
 * Web splits this into a list and a detail pane and opens on the first
 * actionable item. A phone has room for one column, so the card *is* the
 * detail: `buildNeedsYouListItems` re-expresses that pane-selection as section
 * order, and everything is decidable in place.
 */
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { unreadBadgeLabel } from "@shuv2code/client-runtime/ade/contact-rail";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdeCanApprove, useAdeNeedsYouList } from "../../state/ade";
import {
  buildNeedsYouListItems,
  countActionableEntries,
  needsYouEmptyCopy,
  needsYouHistoryToggleLabel,
  type NeedsYouListItem,
} from "./needsYou.logic";
import { NeedsYouCard } from "./NeedsYouCard";
import { useAdeEnvironmentId } from "./useAdeEnvironmentId";

export function NeedsYouRouteScreen() {
  const environmentId = useAdeEnvironmentId();
  const [includeResolved, setIncludeResolved] = useState(false);
  const inbox = useAdeNeedsYouList(environmentId, { includeResolved });
  const canApprove = useAdeCanApprove(environmentId);

  const entries = useMemo(() => inbox.data?.entries ?? [], [inbox.data]);
  const items = useMemo(() => buildNeedsYouListItems(entries), [entries]);
  const actionable = countActionableEntries(entries);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<NeedsYouListItem>) =>
      item.kind === "section" ? (
        <View className="px-5 pb-2 pt-5">
          <Text className="text-xs font-shuv2code-bold uppercase tracking-wide text-foreground-tertiary">
            {item.title}
          </Text>
        </View>
      ) : environmentId === null ? null : (
        <View className="px-5 pb-3">
          <NeedsYouCard canApprove={canApprove} entry={item.entry} environmentId={environmentId} />
        </View>
      ),
    [canApprove, environmentId],
  );
  const keyExtractor = useCallback((item: NeedsYouListItem) => item.key, []);

  if (inbox.error !== null && inbox.data === null) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "Needs You" }} />
        <View className="flex-1 justify-center bg-screen px-6">
          <EmptyState
            actionLabel="Try again"
            detail={inbox.error}
            onAction={inbox.refresh}
            title="Your inbox could not be read"
          />
        </View>
      </>
    );
  }

  if (inbox.data === null && inbox.isPending) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "Needs You" }} />
        <LoadingScreen message="Reading your inbox…" messagePlacement="above-spinner" />
      </>
    );
  }

  const empty = needsYouEmptyCopy(includeResolved);

  return (
    <>
      <NativeStackScreenOptions
        options={{ title: actionable === 0 ? "Needs You" : `Needs You (${actionable})` }}
      />
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center justify-between bg-screen px-5 pb-2 pt-1">
          <Text className="text-sm text-foreground-muted">
            {actionable === 0
              ? "Nothing is waiting on a decision"
              : `${unreadBadgeLabel(actionable)} waiting on a decision`}
          </Text>
          <Pressable
            accessibilityLabel={needsYouHistoryToggleLabel(includeResolved)}
            accessibilityRole="button"
            accessibilityState={{ selected: includeResolved }}
            className={`rounded-full px-3.5 py-1.5 active:opacity-70 ${
              includeResolved ? "bg-primary" : "bg-card-alt"
            }`}
            onPress={() => setIncludeResolved((current) => !current)}
          >
            <Text
              className={`text-sm font-shuv2code-medium ${
                includeResolved ? "text-primary-foreground" : "text-foreground-secondary"
              }`}
            >
              {needsYouHistoryToggleLabel(includeResolved)}
            </Text>
          </Pressable>
        </View>
        {/* Deliberately not `recycleItems`, unlike the contact list: a card
            holds the in-flight state of a decision and the sentence the captain
            reads after making one, and a recycled view would carry "Approved."
            onto a different item. */}
        <LegendList
          contentInsetAdjustmentBehavior={
            NATIVE_LIQUID_GLASS_SUPPORTED || Platform.OS === "ios" ? "automatic" : "never"
          }
          data={items}
          keyExtractor={keyExtractor}
          ListEmptyComponent={
            <View className="px-6 pt-10">
              <EmptyState detail={empty.detail} title={empty.title} variant="plain" />
            </View>
          }
          renderItem={renderItem}
        />
      </View>
    </>
  );
}
