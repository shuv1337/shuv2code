/**
 * The contact list (MESSENGER-PIVOT §3): the phone's whole triage story for
 * bot mode. Every rule it renders — row copy, the "You: " prefix, the unread
 * cap, group bucketing, the Attention filter, the empty-state wording — comes
 * from `@shuv2code/client-runtime/ade/contact-rail`, shared with the web rail,
 * so the two cannot disagree about what a row says.
 *
 * The list itself follows `HomeScreen`: one flat `LegendList` of keyed items,
 * separators drawn by the row, no sticky headers.
 */
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import {
  applyContactRailFilter,
  contactRailEmptyCopy,
  CONTACT_RAIL_FILTERS,
  filterContactRows,
  getContactRowViews,
  unreadBadgeLabel,
  type ContactRailFilter,
  type ContactRowView,
} from "@shuv2code/client-runtime/ade/contact-rail";
import type { AdeRoster, BotId } from "@shuv2code/contracts";
import { memo, useCallback, useMemo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { useThemeColor } from "../../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { buildFleetListItems, type FleetListItem } from "./fleet.logic";
import { BotAvatar } from "./BotAvatar";

export function FleetScreen(props: {
  readonly roster: AdeRoster | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly filter: ContactRailFilter;
  readonly searchQuery: string;
  readonly onRefresh: () => void;
  readonly onSelectBot: (botId: BotId) => void;
  readonly onOpenBotProfile: (botId: BotId) => void;
}) {
  const rows = useMemo(() => getContactRowViews(props.roster), [props.roster]);
  const visibleRows = useMemo(
    () => applyContactRailFilter(filterContactRows(rows, props.searchQuery), props.filter),
    [props.filter, props.searchQuery, rows],
  );
  const groups = useMemo(
    () =>
      (props.roster?.groups ?? []).map((group) => ({
        id: group.id as string,
        name: group.name,
      })),
    [props.roster],
  );
  const items = useMemo(
    () => buildFleetListItems({ rows: visibleRows, groups }),
    [groups, visibleRows],
  );

  const { onOpenBotProfile, onSelectBot } = props;
  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<FleetListItem>) =>
      item.kind === "group" ? (
        <FleetGroupHeader name={item.name} />
      ) : (
        <ContactRow onOpenBotProfile={onOpenBotProfile} onSelectBot={onSelectBot} row={item.row} />
      ),
    [onOpenBotProfile, onSelectBot],
  );
  const keyExtractor = useCallback((item: FleetListItem) => item.key, []);

  if (props.error !== null && props.roster === null) {
    return (
      <View className="flex-1 justify-center bg-screen px-6">
        <EmptyState
          title="The fleet could not be read"
          detail={props.error}
          actionLabel="Try again"
          onAction={props.onRefresh}
        />
      </View>
    );
  }

  if (props.roster === null && props.isPending) {
    return <LoadingScreen message="Reading the fleet…" messagePlacement="above-spinner" />;
  }

  const empty = contactRailEmptyCopy({
    totalRows: rows.length,
    query: props.searchQuery,
    filter: props.filter,
  });

  return (
    <View className="flex-1 bg-screen">
      <LegendList
        contentInsetAdjustmentBehavior={
          NATIVE_LIQUID_GLASS_SUPPORTED || Platform.OS === "ios" ? "automatic" : "never"
        }
        data={items}
        keyExtractor={keyExtractor}
        ListEmptyComponent={
          <View className="px-6 pt-10">
            <EmptyState title={empty.title} detail={empty.description} variant="plain" />
          </View>
        }
        recycleItems
        renderItem={renderItem}
      />
    </View>
  );
}

/**
 * The rail's two views as the segmented control a phone expects, plus the way
 * in to Needs You.
 *
 * The inbox lives here rather than in the native header on purpose: the header
 * is the part of this surface that could not be verified without a simulator,
 * and a triage entry point that might not render is worse than one that is a
 * row lower down.
 */
export function FleetFilterBar(props: {
  readonly filter: ContactRailFilter;
  readonly attentionCount: number;
  readonly needsYouCount: number;
  readonly onFilterChange: (filter: ContactRailFilter) => void;
  readonly onOpenNeedsYou: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2 bg-screen px-5 pb-2 pt-1">
      {CONTACT_RAIL_FILTERS.map((filter) => {
        const selected = filter === props.filter;
        const label = filter === "all" ? "All" : "Attention";
        return (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={`flex-row items-center gap-1.5 rounded-full px-3.5 py-1.5 active:opacity-70 ${
              selected ? "bg-primary" : "bg-card-alt"
            }`}
            key={filter}
            onPress={() => props.onFilterChange(filter)}
          >
            <Text
              className={`text-sm font-shuv2code-medium ${
                selected ? "text-primary-foreground" : "text-foreground-secondary"
              }`}
            >
              {label}
            </Text>
            {filter === "attention" && props.attentionCount > 0 ? (
              <Text
                className={`text-xs font-shuv2code-bold tabular-nums ${
                  selected ? "text-primary-foreground" : "text-foreground-muted"
                }`}
              >
                {unreadBadgeLabel(props.attentionCount)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      <View className="flex-1" />
      <Pressable
        accessibilityHint="Shows everything waiting on a decision"
        accessibilityLabel={
          props.needsYouCount === 0
            ? "Needs You"
            : `Needs You, ${unreadBadgeLabel(props.needsYouCount)} open`
        }
        accessibilityRole="button"
        className={`flex-row items-center gap-1.5 rounded-full px-3.5 py-1.5 active:opacity-70 ${
          props.needsYouCount > 0 ? "bg-danger" : "bg-card-alt"
        }`}
        onPress={props.onOpenNeedsYou}
      >
        <Text
          className={`text-sm font-shuv2code-medium ${
            props.needsYouCount > 0 ? "text-danger-foreground" : "text-foreground-secondary"
          }`}
        >
          Needs You
        </Text>
        {props.needsYouCount > 0 ? (
          <Text className="text-xs font-shuv2code-bold tabular-nums text-danger-foreground">
            {unreadBadgeLabel(props.needsYouCount)}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function FleetGroupHeader({ name }: { readonly name: string }) {
  return (
    <View
      className="bg-screen"
      style={{
        paddingLeft: HOME_HORIZONTAL_INSET,
        paddingRight: 18,
        paddingBottom: 6,
        paddingTop: 18,
      }}
    >
      <Text className="text-xs font-shuv2code-bold uppercase tracking-wide text-foreground-tertiary">
        {name}
      </Text>
    </View>
  );
}

const ContactRow = memo(function ContactRow({
  row,
  onOpenBotProfile,
  onSelectBot,
}: {
  readonly row: ContactRowView;
  readonly onOpenBotProfile: (botId: BotId) => void;
  readonly onSelectBot: (botId: BotId) => void;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  // The amber line replaces the preview when something is waiting on a
  // decision (§2). Both are carried on the row so this is a choice, not a
  // re-derivation.
  const secondary = row.attentionLine ?? row.secondaryLine;

  return (
    <Pressable
      accessibilityHint="Opens the conversation with this bot"
      accessibilityLabel={row.unreadLabel === null ? row.name : `${row.name}, ${row.unreadLabel}`}
      accessibilityRole="button"
      className="bg-screen"
      onLongPress={() => onOpenBotProfile(row.botId)}
      onPress={() => onSelectBot(row.botId)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ paddingLeft: HOME_HORIZONTAL_INSET, paddingRight: 18, paddingTop: 10 }}>
        <View
          className="flex-row items-center gap-3"
          style={{ borderBottomWidth: 1, borderBottomColor: separatorColor, paddingBottom: 10 }}
        >
          <View>
            <BotAvatar avatar={row.avatar} />
            {row.isOnline ? (
              <View
                accessibilityLabel={row.presenceLabel}
                className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-screen bg-emerald-500"
              />
            ) : null}
          </View>
          <View className="flex-1" style={{ gap: 2 }}>
            <View className="flex-row items-center gap-2">
              <Text
                className="flex-1 text-lg font-shuv2code-bold text-foreground"
                numberOfLines={1}
              >
                {row.name}
              </Text>
              {row.timeLabel === null ? null : (
                <Text className="text-sm tabular-nums text-foreground-tertiary">
                  {row.timeLabel}
                </Text>
              )}
              {/* The chevron this replaces said only "this row navigates",
                  which tapping the row already does. An info control is the
                  same one tap and adds the profile — where identity, model,
                  desktop state and fleet health live. `hitSlop` rather than a
                  bigger box so the row's rhythm is unchanged. */}
              <Pressable
                accessibilityHint="Opens this bot's profile"
                accessibilityLabel={`About ${row.name}`}
                accessibilityRole="button"
                hitSlop={12}
                onPress={() => onOpenBotProfile(row.botId)}
              >
                <SymbolView
                  name="info.circle"
                  size={17}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
              </Pressable>
            </View>
            <View className="flex-row items-center gap-2">
              <Text
                className={`flex-1 text-base ${
                  row.attentionLine !== null
                    ? "font-shuv2code-medium text-amber-600"
                    : "text-foreground-muted"
                }`}
                numberOfLines={1}
              >
                {secondary}
              </Text>
              {row.unreadCount > 0 ? (
                <View className="min-w-6 items-center rounded-full bg-primary px-2 py-0.5">
                  <Text className="text-xs font-shuv2code-bold tabular-nums text-primary-foreground">
                    {unreadBadgeLabel(row.unreadCount)}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
});
