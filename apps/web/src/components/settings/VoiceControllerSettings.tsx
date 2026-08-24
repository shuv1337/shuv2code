import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type VoiceControllerIdentity,
  type VoiceNarrationLevel,
} from "@shuv2code/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createModelSelection } from "@shuv2code/shared/model";
import { MicIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { VoiceControllerConfigurationDetails } from "../voice/VoiceControllerDetails";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NARRATION_LEVEL_OPTIONS: Readonly<
  Record<VoiceNarrationLevel, { readonly label: string; readonly description: string }>
> = {
  quiet: {
    label: "Quiet",
    description: "Only blockers, questions, and the final result are spoken.",
  },
  balanced: {
    label: "Balanced",
    description: "Useful milestones are spoken, with an update after roughly 30 silent seconds.",
  },
  conversational: {
    label: "Conversational",
    description:
      "Meaningful tool transitions are spoken, with an update after roughly 15 silent seconds.",
  },
};

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

type ControllerStatus =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly controller: VoiceControllerIdentity | null }
  | { readonly type: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice controller could not be read.";
}

export function VoiceControllerSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const narrationLevel = settings.voiceNarrationLevel;
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateSettings = useUpdatePrimarySettings();
  const voice = useVoiceSession();
  const getController = voice.getController;
  const resetController = voice.resetController;
  const [status, setStatus] = useState<ControllerStatus>({ type: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [realtimeModelDraft, setRealtimeModelDraft] = useState(settings.voiceRealtimeModel);
  const controllerInstances = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ).filter((entry) => entry.driverKind === "codex"),
    [providers, settings],
  );
  const controllerModelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        settings.voiceControllerModelSelection.instanceId,
        settings.voiceControllerModelSelection.model,
      ),
    [providers, settings],
  );

  useEffect(() => {
    setRealtimeModelDraft(settings.voiceRealtimeModel);
  }, [settings.voiceRealtimeModel]);

  const saveRealtimeModel = () => {
    const model = realtimeModelDraft.trim();
    if (model.length === 0) {
      setRealtimeModelDraft(settings.voiceRealtimeModel);
      return;
    }
    if (model !== settings.voiceRealtimeModel) updateSettings({ voiceRealtimeModel: model });
  };

  const load = useCallback(async () => {
    const environmentId = primaryEnvironment?.environmentId;
    if (!environmentId) {
      setStatus({ type: "ready", controller: null });
      return;
    }
    if (primaryEnvironment.connection.phase !== "connected") {
      setStatus({ type: "loading" });
      return;
    }
    setStatus({ type: "loading" });
    try {
      const controller = await getController(environmentId);
      setStatus({ type: "ready", controller });
    } catch (error) {
      setStatus({ type: "error", message: errorMessage(error) });
    }
  }, [getController, primaryEnvironment]);

  useEffect(() => {
    void load();
  }, [load]);

  const controller = status.type === "ready" ? status.controller : null;
  const reset = async () => {
    if (!primaryEnvironment || !controller) return;
    setResetting(true);
    try {
      const reset = await resetController(
        primaryEnvironment.environmentId,
        controller.controllerThreadId,
      );
      if (!reset) {
        throw new Error("The controller changed before it could be reset. Refresh and try again.");
      }
      setConfirmOpen(false);
      setStatus({ type: "ready", controller: null });
    } catch (error) {
      setConfirmOpen(false);
      setStatus({ type: "error", message: errorMessage(error) });
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <SettingsSection title="Voice control" icon={<MicIcon className="size-5" />}>
        <SettingsRow
          id={searchableSetting("call-narration").id}
          title={searchableSetting("call-narration").title}
          description={NARRATION_LEVEL_OPTIONS[narrationLevel].description}
          resetAction={
            narrationLevel !== DEFAULT_SERVER_SETTINGS.voiceNarrationLevel ? (
              <SettingResetButton
                label="call narration"
                onClick={() =>
                  updateSettings({
                    voiceNarrationLevel: DEFAULT_SERVER_SETTINGS.voiceNarrationLevel,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={narrationLevel}
              onValueChange={(value) =>
                updateSettings({ voiceNarrationLevel: value as VoiceNarrationLevel })
              }
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Call narration">
                <SelectValue>{NARRATION_LEVEL_OPTIONS[narrationLevel].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(NARRATION_LEVEL_OPTIONS) as VoiceNarrationLevel[]).map((level) => (
                  <SelectItem key={level} hideIndicator value={level}>
                    {NARRATION_LEVEL_OPTIONS[level].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Controller model"
          description="The Codex model that plans voice actions and works with the active thread. Existing controller bindings reconnect with this selection."
          resetAction={
            settings.voiceControllerModelSelection.instanceId !==
              DEFAULT_SERVER_SETTINGS.voiceControllerModelSelection.instanceId ||
            settings.voiceControllerModelSelection.model !==
              DEFAULT_SERVER_SETTINGS.voiceControllerModelSelection.model ? (
              <SettingResetButton
                label="controller model"
                onClick={() =>
                  updateSettings({
                    voiceControllerModelSelection:
                      DEFAULT_SERVER_SETTINGS.voiceControllerModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            controllerInstances.length > 0 ? (
              <ProviderModelPicker
                activeInstanceId={settings.voiceControllerModelSelection.instanceId}
                model={settings.voiceControllerModelSelection.model}
                lockedProvider={CODEX_PROVIDER}
                instanceEntries={controllerInstances}
                modelOptionsByInstance={controllerModelOptions}
                triggerVariant="outline"
                triggerClassName="w-full max-w-none sm:w-64"
                triggerAriaLabel="Voice controller model"
                onInstanceModelChange={(instanceId, model) =>
                  updateSettings({
                    voiceControllerModelSelection: createModelSelection(instanceId, model),
                  })
                }
              />
            ) : (
              <span className="text-sm text-muted-foreground">No Codex model available</span>
            )
          }
        />

        <SettingsRow
          title="Realtime speech model"
          description="The Codex realtime model used for live audio. The default is pinned to the ChatGPT-compatible model validated for WebRTC."
          resetAction={
            settings.voiceRealtimeModel !== DEFAULT_SERVER_SETTINGS.voiceRealtimeModel ? (
              <SettingResetButton
                label="realtime speech model"
                onClick={() =>
                  updateSettings({ voiceRealtimeModel: DEFAULT_SERVER_SETTINGS.voiceRealtimeModel })
                }
              />
            ) : null
          }
          control={
            <Input
              className="w-full font-mono sm:w-64"
              aria-label="Realtime speech model"
              value={realtimeModelDraft}
              onChange={(event) => setRealtimeModelDraft(event.target.value)}
              onBlur={saveRealtimeModel}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setRealtimeModelDraft(settings.voiceRealtimeModel);
                  event.currentTarget.blur();
                }
              }}
            />
          }
        />

        <SettingsRow
          title="Environment controller"
          description="One controller is securely bound to this environment. Reset it before changing its host project, provider, or authority ceiling."
          status={
            status.type === "loading"
              ? "Checking the current binding…"
              : status.type === "error"
                ? status.message
                : controller
                  ? "A controller is configured."
                  : "No controller is configured."
          }
          control={
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={status.type === "loading" || resetting}
                onClick={() => void load()}
              >
                <RefreshCwIcon />
                Refresh
              </Button>
              {controller ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive-outline"
                  disabled={resetting}
                  onClick={() => setConfirmOpen(true)}
                >
                  Reset controller
                </Button>
              ) : null}
            </div>
          }
        >
          {controller ? (
            <VoiceControllerConfigurationDetails
              className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3"
              controller={controller}
              hostProjectId={controller.hostProjectId}
              providerInstanceId={controller.providerInstanceId}
              authorizedRuntimeCeiling={controller.authorizedRuntimeCeiling}
              model={settings.voiceControllerModelSelection.model}
            />
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the environment voice controller?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends active voice control, revokes its controller credentials, and archives only
              the hidden controller thread. Ordinary project threads and their work are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={resetting} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={resetting} onClick={() => void reset()}>
              {resetting ? "Resetting…" : "Reset controller"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
