/**
 * One bot's profile (spec §7 slice 2, MESSENGER-PIVOT §3).
 *
 * Web spreads this across a right rail and a detail panel; a phone reads it as
 * one scrolling page. Every fact on it comes from a shared module — the header
 * and bindings from `…/ade/bot-detail`, the model row from `…/ade/bot-model`,
 * the desktop phase from `…/ade/bot-screen`, the health pills from
 * `…/ade/kernel-health` — so the phone and the captain machine describe the
 * same bot in the same words.
 *
 * The two editable things (identity, model) open as form sheets rather than
 * editing in place: both are saves the captain should be able to abandon, and a
 * sheet is the gesture a phone already has for that.
 */
import { getBindingRowViews, getBotHeaderView } from "@shuv2code/client-runtime/ade/bot-detail";
import { getBotAvatarView } from "@shuv2code/client-runtime/ade/contact-rail";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { BotId, EnvironmentId } from "@shuv2code/contracts";
import { useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  useAdeBotDetail,
  useAdeBotModelOptions,
  useAdeBotScreen,
  useAdeFleetHealth,
} from "../../state/ade";
import { BotAvatar } from "./BotAvatar";
import {
  getBotModelRowView,
  getBotScreenMobileView,
  getPersonaHistoryView,
} from "./botProfile.logic";
import { getKernelHealthPillViews } from "./kernelHealth.logic";
import { KernelHealthPills } from "./KernelHealthPills";

type BotProfileRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
}>;

export function BotProfileRouteScreen(props: BotProfileRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const botId = BotId.make(props.route.params.botId);

  const detail = useAdeBotDetail(environmentId, botId);
  const screen = useAdeBotScreen(environmentId, botId);
  const fleetHealth = useAdeFleetHealth(environmentId);
  const modelOptions = useAdeBotModelOptions(environmentId);

  const header = detail.data === null ? null : getBotHeaderView(detail.data);
  const title = header?.name ?? "Bot";
  const modelRow = getBotModelRowView(detail.data, modelOptions);
  const personaHistory = useMemo(() => getPersonaHistoryView(detail.data), [detail.data]);
  const bindings = useMemo(
    () => (detail.data === null ? [] : getBindingRowViews(detail.data.bindings)),
    [detail.data],
  );
  const screenView = getBotScreenMobileView({ screen: screen.data, botName: title });
  const healthPills = getKernelHealthPillViews(fleetHealth);

  if (detail.data === null) {
    return (
      <>
        <NativeStackScreenOptions options={{ title }} />
        {detail.error === null ? (
          <LoadingScreen message="Reading this bot…" messagePlacement="above-spinner" />
        ) : (
          <View className="flex-1 justify-center bg-screen px-6">
            <EmptyState
              actionLabel="Try again"
              detail={detail.error}
              onAction={detail.refresh}
              title="This bot could not be read"
            />
          </View>
        )}
      </>
    );
  }

  const avatar = getBotAvatarView({
    botId: String(botId),
    name: detail.data.bot.name,
    displayMeta: detail.data.bot.displayMeta,
  });
  const memory = detail.data.memory.content.trim();

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android", title }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader onBack={() => navigation.goBack()} title={title} />
      ) : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center gap-2 pb-2">
          <BotAvatar avatar={avatar} size={72} />
          <Text className="text-2xl font-shuv2code-bold text-foreground">{header?.name}</Text>
          <Text className="text-sm text-foreground-muted">
            {header === null ? "" : `${header.roleLabel} · ${header.projectLabel}`}
          </Text>
          {header === null || header.roleTag.length === 0 ? null : (
            <Text className="text-sm text-foreground-tertiary">{header.roleTag}</Text>
          )}
        </View>

        <SettingsSection title="Bot">
          <SettingsRow
            icon="person.crop.circle"
            label="Identity"
            onPress={() =>
              navigation.navigate("BotIdentitySheet", {
                environmentId: String(environmentId),
                botId: String(botId),
              })
            }
            value={header?.name}
          />
          <SettingsRow
            icon="slider.horizontal.3"
            label="Model"
            onPress={() =>
              navigation.navigate("BotModelSheet", {
                environmentId: String(environmentId),
                botId: String(botId),
              })
            }
            value={modelRow.label}
          />
        </SettingsSection>
        {modelRow.warning === null ? null : (
          <Text className="px-2 text-xs text-foreground-tertiary">{modelRow.warning}</Text>
        )}

        {screenView === null ? null : (
          <SettingsSection title="Screen">
            <View className="gap-1 p-4">
              <Text className="text-base font-shuv2code-bold text-foreground">
                {screenView.headline}
              </Text>
              {screenView.detail.length === 0 ? null : (
                <Text className="text-sm leading-relaxed text-foreground-muted">
                  {screenView.detail}
                </Text>
              )}
              {screenView.viewersLabel === null ? null : (
                <Text className="text-xs text-foreground-tertiary">{screenView.viewersLabel}</Text>
              )}
            </View>
          </SettingsSection>
        )}

        <SettingsSection title="Fleet health">
          <View className="p-4">
            <KernelHealthPills pills={healthPills} />
          </View>
        </SettingsSection>

        <SettingsSection title="Sessions">
          {bindings.length === 0 ? (
            <View className="p-4">
              <Text className="text-sm text-foreground-muted">
                No kernel session yet. One starts when you open this conversation.
              </Text>
            </View>
          ) : (
            bindings.map((binding, index) => (
              <View
                className={
                  index === 0 ? "gap-0.5 p-4" : "gap-0.5 border-t border-border-subtle p-4"
                }
                key={binding.id}
              >
                <Text className="text-base text-foreground">{binding.purpose}</Text>
                <Text className="text-xs text-foreground-tertiary">
                  {binding.engine} · {binding.status}
                </Text>
              </View>
            ))
          )}
        </SettingsSection>

        <SettingsSection title="Persona">
          {personaHistory.versions.length === 0 ? (
            <View className="p-4">
              <Text className="text-sm text-foreground-muted">
                This bot is running its template persona.
              </Text>
            </View>
          ) : (
            personaHistory.versions.map((version, index) => (
              <View
                className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
                key={version.id}
              >
                <Text className="text-xs font-shuv2code-bold uppercase tracking-wide text-foreground-tertiary">
                  {version.stateLabel}
                </Text>
                <Text className="text-sm leading-relaxed text-foreground-secondary">
                  {version.content}
                </Text>
              </View>
            ))
          )}
        </SettingsSection>
        {personaHistory.hiddenLabel === null ? null : (
          <Text className="px-2 text-xs text-foreground-tertiary">
            {personaHistory.hiddenLabel} not shown.
          </Text>
        )}

        {memory.length === 0 ? null : (
          <SettingsSection title="Memory">
            <View className="p-4">
              <Text className="text-sm leading-relaxed text-foreground-secondary">{memory}</Text>
            </View>
          </SettingsSection>
        )}
      </ScrollView>
    </View>
  );
}
