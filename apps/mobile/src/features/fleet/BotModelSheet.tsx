/**
 * Pin one bot to one shuvcode model (MESSENGER-PIVOT §3).
 *
 * The list, the capability flag, the "applies next session" note and the
 * sentence shown after a save are all
 * `@shuv2code/client-runtime/ade/bot-model`, shared with the web picker. Two of
 * those shares are load-bearing rather than tidy:
 *
 *  - A model the kernel reports as unable to call tools is **listed and
 *    selectable**, marked rather than hidden. Capability data is provider
 *    reported and can be absent for a model the captain knows works.
 *  - The saved message never says "Saved." alone. A live session keeps the
 *    model it was created with, so the outcome is either "running it now" or
 *    "next time", and only the server knows which.
 */
import {
  getBotModelSavedMessage,
  ADE_MODEL_INSTANCE_ID,
  hasLivePrimarySession,
  shouldSubmitBotModel,
  BOT_MODEL_NEXT_SESSION_NOTE,
  BOT_MODEL_RESTART_NOTE,
  BOT_MODEL_UNSUPPORTED_HINT,
} from "@shuv2code/client-runtime/ade/bot-model";
import { adeCaptainErrorMessage } from "@shuv2code/client-runtime/ade/logic";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { BotId, EnvironmentId } from "@shuv2code/contracts";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsSection } from "../settings/components/SettingsSection";
import { adeEnvironment, useAdeBotDetail, useAdeBotModelOptions } from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";

type BotModelSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
}>;

export function BotModelSheetRouteScreen(props: BotModelSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const botId = BotId.make(props.route.params.botId);

  const detail = useAdeBotDetail(environmentId, botId);
  const options = useAdeBotModelOptions(environmentId);
  const setModel = useAtomCommand(adeEnvironment.setBotModel, { reportFailure: false });

  const current = detail.data?.modelSlug ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [restartSession, setRestartSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const pick = selected ?? current;
  const live = hasLivePrimarySession(detail.data?.bindings ?? []);
  const canSubmit = !busy && shouldSubmitBotModel(current, pick, restartSession);

  const save = async () => {
    if (!shouldSubmitBotModel(current, pick, restartSession)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await setModel({
      environmentId,
      input: {
        botId,
        modelSelection: { instanceId: ADE_MODEL_INSTANCE_ID, model: pick },
        ...(restartSession ? { restartSession: true } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(squashAtomCommandFailure(result), "That model could not be saved."),
      );
      return;
    }
    setSaved(getBotModelSavedMessage(result.value));
  };

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: "Model" }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader onBack={() => navigation.goBack()} title="Model" />
      ) : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        showsVerticalScrollIndicator={false}
      >
        {options.length === 0 ? (
          <SettingsSection title="Models">
            <View className="p-4">
              <Text className="text-sm leading-relaxed text-foreground-muted">
                This environment&apos;s shuvcode kernel has not reported a model catalog. Until it
                does, this bot runs whatever the kernel resolves.
              </Text>
            </View>
          </SettingsSection>
        ) : (
          <SettingsSection title="Models">
            {options.map((option, index) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: pick === option.slug }}
                className={
                  index === 0
                    ? "flex-row items-center gap-4 p-4"
                    : "flex-row items-center gap-4 border-t border-border-subtle p-4"
                }
                key={option.slug}
                onPress={() => setSelected(option.slug)}
              >
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-lg text-foreground" numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.agentCapable ? null : (
                    <Text className="text-sm text-foreground-tertiary">
                      {BOT_MODEL_UNSUPPORTED_HINT}
                    </Text>
                  )}
                </View>
                {pick === option.slug ? (
                  <SymbolView name="checkmark" size={18} type="monochrome" weight="semibold" />
                ) : null}
              </Pressable>
            ))}
          </SettingsSection>
        )}

        <Text className="px-2 text-xs leading-relaxed text-foreground-tertiary">
          {BOT_MODEL_NEXT_SESSION_NOTE}
        </Text>

        {/* Offered only when there is a session to restart. With no live primary
            binding the setting is already in force on the next turn, and a
            restart control there would be an act with nothing to act on. */}
        {live ? (
          <SettingsSection title="Apply now">
            <View className="gap-2 p-4">
              <View className="flex-row items-center gap-4">
                <Text className="min-w-0 flex-1 text-lg text-foreground">Restart the session</Text>
                <Switch onValueChange={setRestartSession} value={restartSession} />
              </View>
              <Text className="text-sm leading-relaxed text-foreground-muted">
                {BOT_MODEL_RESTART_NOTE}
              </Text>
            </View>
          </SettingsSection>
        ) : null}

        {error === null ? null : (
          <Text accessibilityLiveRegion="assertive" className="px-2 text-sm text-danger-foreground">
            {error}
          </Text>
        )}
        {saved === null ? null : (
          <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-foreground-muted">
            {saved}
          </Text>
        )}

        <Pressable
          accessibilityLabel="Save"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          className={`mt-2 items-center rounded-full px-5 py-3 ${
            canSubmit ? "bg-primary active:opacity-70" : "bg-card-alt"
          }`}
          disabled={!canSubmit}
          onPress={() => void save()}
        >
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Text
              className={`text-base font-shuv2code-bold ${
                canSubmit ? "text-primary-foreground" : "text-foreground-tertiary"
              }`}
            >
              Save
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}
