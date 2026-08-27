/**
 * Rename, re-decorate, re-tag and re-file one bot (MESSENGER-PIVOT §3, #197).
 *
 * Every rule the sheet obeys is `@shuv2code/client-runtime/ade/bot-identity`,
 * shared verbatim with the web sheet: what a draft is, how a poll folds into an
 * open one without eating the captain's typing, what makes a draft invalid, and
 * which five keys a patch may carry. That last one is the important share — the
 * patch shape is where "the sheet edits a label, never a structural role" is
 * enforced, and a second implementation of it on the phone would be a second
 * place that boundary could slip.
 */
import {
  buildBotIdentityPatch,
  getBotIdentityValidationMessage,
  getGroupAssignOptions,
  openBotIdentitySheet,
  reconcileBotIdentitySheet,
  BOT_AVATAR_COLORS,
  BOT_EMOJI_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_ROLE_TAG_MAX_LENGTH,
  ROLE_TAG_ROUTING_HINT,
  type BotIdentitySheetState,
} from "@shuv2code/client-runtime/ade/bot-identity";
import { adeCaptainErrorMessage } from "@shuv2code/client-runtime/ade/logic";
import { squashAtomCommandFailure } from "@shuv2code/client-runtime/state/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { BotId, EnvironmentId, type AdeBotGroupId } from "@shuv2code/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsSection } from "../settings/components/SettingsSection";
import { adeEnvironment, useAdeBotDetail, useAdeRoster } from "../../state/ade";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveBotAvatarTint } from "./fleet.logic";

type BotIdentitySheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
}>;

export function BotIdentitySheetRouteScreen(props: BotIdentitySheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const botId = BotId.make(props.route.params.botId);

  const detail = useAdeBotDetail(environmentId, botId);
  const roster = useAdeRoster(environmentId);
  const update = useAtomCommand(adeEnvironment.updateBotIdentity, { reportFailure: false });

  const [sheet, setSheet] = useState<BotIdentitySheetState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * `reconcileBotIdentitySheet` is what makes this an effect rather than a
   * defect: the bot detail re-polls every 15 seconds and the roster pushes on
   * every change, so "the bot prop moved" says nothing about whether the
   * captain's typing is stale. The shared reducer keeps a dirty draft, adopts a
   * pristine one, and raises `changedElsewhere` only when the server genuinely
   * moved under an edit in progress.
   */
  const bot = detail.data?.bot ?? null;
  useEffect(() => {
    if (bot === null) return;
    setSheet((current) =>
      current === null ? openBotIdentitySheet(bot) : reconcileBotIdentitySheet(current, bot),
    );
  }, [bot]);

  if (bot === null || sheet === null) {
    return (
      <SheetShell insets={insets} onClose={() => navigation.goBack()} title="Identity">
        <LoadingScreen message="Reading this bot…" messagePlacement="above-spinner" />
      </SheetShell>
    );
  }

  const draft = sheet.draft;
  const patch = buildBotIdentityPatch(bot, draft);
  const validation = getBotIdentityValidationMessage(draft);
  const canSave = !busy && validation === null && patch !== null;
  const groups = roster.data?.groups ?? [];

  const setDraft = (patchDraft: Partial<typeof draft>) => {
    setSheet((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patchDraft } },
    );
  };

  const save = async () => {
    if (patch === null) return;
    setBusy(true);
    setError(null);
    const result = await update({ environmentId, input: patch });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(
        adeCaptainErrorMessage(squashAtomCommandFailure(result), "That change could not be saved."),
      );
      return;
    }
    navigation.goBack();
  };

  return (
    <SheetShell insets={insets} onClose={() => navigation.goBack()} title="Identity">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {sheet.changedElsewhere ? (
          <View className="rounded-[18px] border border-border bg-card-alt p-3">
            <Text className="text-sm text-foreground-secondary">
              This bot changed somewhere else while you were editing. Your changes are kept — saving
              will apply them on top.
            </Text>
          </View>
        ) : null}

        <SettingsSection title="Name">
          <View className="p-3">
            <TextInput
              accessibilityLabel="Bot name"
              autoCapitalize="words"
              className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base leading-snug"
              maxLength={BOT_NAME_MAX_LENGTH}
              onChangeText={(value) => setDraft({ name: value })}
              placeholder="Bosun"
              returnKeyType="done"
              value={draft.name}
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Role tag">
          <View className="gap-2 p-3">
            <TextInput
              accessibilityLabel="Role tag"
              autoCapitalize="words"
              className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base leading-snug"
              maxLength={BOT_ROLE_TAG_MAX_LENGTH}
              onChangeText={(value) => setDraft({ roleTag: value })}
              placeholder="Reviewer"
              returnKeyType="done"
              value={draft.roleTag}
            />
            {/* Not a warning about a mistake: #197 keeps this field free text on
                purpose, so the routing consequence is disclosed rather than
                prevented. */}
            <Text className="px-1 text-xs text-foreground-tertiary">{ROLE_TAG_ROUTING_HINT}</Text>
          </View>
        </SettingsSection>

        <SettingsSection title="Emoji">
          <View className="p-3">
            <TextInput
              accessibilityLabel="Avatar emoji"
              autoCapitalize="none"
              autoCorrect={false}
              className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base leading-snug"
              maxLength={BOT_EMOJI_MAX_LENGTH}
              onChangeText={(value) => setDraft({ emoji: value })}
              placeholder="Leave empty for initials"
              returnKeyType="done"
              value={draft.emoji}
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Color">
          <View className="flex-row flex-wrap gap-3 p-4">
            {BOT_AVATAR_COLORS.map((token) => {
              const selected = draft.color === token;
              const tint = resolveBotAvatarTint({ color: token, hue: 0 });
              return (
                <Pressable
                  accessibilityLabel={token}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  className={cn(
                    "h-10 w-10 items-center justify-center rounded-full",
                    tint.className,
                    selected ? "border-2 border-foreground" : null,
                  )}
                  key={token}
                  onPress={() => setDraft({ color: selected ? "" : token })}
                >
                  {selected ? (
                    <SymbolView name="checkmark" size={16} tintColor="#ffffff" type="monochrome" />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </SettingsSection>

        <SettingsSection title="Group">
          {getGroupAssignOptions(groups, draft.groupId).map((option, index) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: draft.groupId === option.groupId }}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
              key={option.groupId ?? "__ungrouped__"}
              onPress={() => setDraft({ groupId: option.groupId as AdeBotGroupId | null })}
            >
              <Text className="min-w-0 flex-1 text-lg text-foreground">{option.label}</Text>
              {draft.groupId === option.groupId ? (
                <SymbolView name="checkmark" size={18} type="monochrome" weight="semibold" />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>

        {validation === null ? null : (
          <Text className="px-2 text-sm text-danger-foreground">{validation}</Text>
        )}
        {error === null ? null : (
          <Text accessibilityLiveRegion="assertive" className="px-2 text-sm text-danger-foreground">
            {error}
          </Text>
        )}

        <Pressable
          accessibilityLabel="Save"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          className={`mt-2 items-center rounded-full px-5 py-3 ${
            canSave ? "bg-primary active:opacity-70" : "bg-card-alt"
          }`}
          disabled={!canSave}
          onPress={() => void save()}
        >
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Text
              className={`text-base font-shuv2code-bold ${
                canSave ? "text-primary-foreground" : "text-foreground-tertiary"
              }`}
            >
              Save
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </SheetShell>
  );
}

function SheetShell(props: {
  readonly children: React.ReactNode;
  readonly insets: { readonly top: number };
  readonly onClose: () => void;
  readonly title: string;
}) {
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: props.title }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader onBack={props.onClose} title={props.title} />
      ) : null}
      {props.children}
    </View>
  );
}
