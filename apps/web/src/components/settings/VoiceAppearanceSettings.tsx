import { DEFAULT_CLIENT_SETTINGS, type VoicePresenceVariation } from "@shuv2code/contracts";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { VoicePresence } from "../voice/VoicePresence";
import { deriveVoicePresenceIdentity } from "../voice/voicePresenceIdentity";
import { voicePhaseStyle } from "../voice/voicePresenceTheme";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const VARIATION_OPTIONS: Readonly<
  Record<VoicePresenceVariation, { readonly label: string; readonly description: string }>
> = {
  subtle: {
    label: "Subtle",
    description: "Threads keep distinct color and movement with less spatial variation.",
  },
  balanced: {
    label: "Balanced",
    description: "Threads use the full curated range while remaining calm and recognizable.",
  },
};

function shortThreadId(threadId: string): string {
  return threadId.length <= 16 ? threadId : `…${threadId.slice(-14)}`;
}

export function VoiceAppearanceSettings() {
  const voice = useVoiceSession();
  const variation = usePrimarySettings((settings) => settings.voicePresenceVariation);
  const contextTint = usePrimarySettings((settings) => settings.voicePresenceContextTint);
  const updateSettings = useUpdatePrimarySettings();
  const activeThreadId =
    voice.state.owner?.kind === "thread-call" ? String(voice.state.owner.threadId) : null;
  const previewThreadId = activeThreadId ?? "voice-presence-preview-thread";
  const projectKey =
    voice.state.activeTarget?.projectId ?? voice.state.controller?.projectId ?? "preview-project";
  const identity = useMemo(
    () =>
      deriveVoicePresenceIdentity({
        threadId: previewThreadId,
        projectKey,
        contextTint,
        variation,
      }),
    [contextTint, previewThreadId, projectKey, variation],
  );

  return (
    <SettingsSection
      id={searchableSetting("call-appearance").id}
      title={searchableSetting("call-appearance").title}
      icon={<SparklesIcon className="size-5" />}
    >
      <SettingsRow
        title="Thread variation"
        description={VARIATION_OPTIONS[variation].description}
        resetAction={
          variation !== DEFAULT_CLIENT_SETTINGS.voicePresenceVariation ? (
            <SettingResetButton
              label="thread variation"
              onClick={() =>
                updateSettings({
                  voicePresenceVariation: DEFAULT_CLIENT_SETTINGS.voicePresenceVariation,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={variation}
            onValueChange={(value) =>
              updateSettings({ voicePresenceVariation: value as VoicePresenceVariation })
            }
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Thread material variation">
              <SelectValue>{VARIATION_OPTIONS[variation].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(VARIATION_OPTIONS) as VoicePresenceVariation[]).map((option) => (
                <SelectItem key={option} hideIndicator value={option}>
                  {VARIATION_OPTIONS[option].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        <div className="mt-3 grid items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-[minmax(0,0.8fr)_auto_minmax(12rem,1.2fr)]">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">
              {activeThreadId === null ? "Example thread ID" : "Current call thread ID"}
            </p>
            <p className="mt-1 truncate font-mono text-xs text-foreground" title={previewThreadId}>
              {shortThreadId(previewThreadId)}
            </p>
          </div>
          <ArrowRightIcon
            className="hidden size-4 text-muted-foreground sm:block"
            aria-hidden="true"
          />
          <div
            className="relative h-24 min-w-0 overflow-hidden rounded-md border border-border/50"
            style={voicePhaseStyle("idle", identity)}
          >
            <VoicePresence phase="idle" identity={identity} />
            <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between bg-linear-to-t from-background/80 to-transparent px-2.5 pt-6 pb-2">
              <span className="text-[11px] font-medium text-foreground">Thread material</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {identity.code.slice(0, 6)}
              </span>
            </div>
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Context tint"
        description="Let the active provider and project add a restrained tint without changing the thread's movement identity."
        resetAction={
          contextTint !== DEFAULT_CLIENT_SETTINGS.voicePresenceContextTint ? (
            <SettingResetButton
              label="context tint"
              onClick={() =>
                updateSettings({
                  voicePresenceContextTint: DEFAULT_CLIENT_SETTINGS.voicePresenceContextTint,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={contextTint}
            onCheckedChange={(checked) =>
              updateSettings({ voicePresenceContextTint: Boolean(checked) })
            }
            aria-label="Use provider and project tint"
          />
        }
      />
    </SettingsSection>
  );
}
