import {
  DEFAULT_SERVER_SETTINGS,
  MAX_TEXT_TO_SPEECH_SPEED,
  MIN_TEXT_TO_SPEECH_SPEED,
} from "@shuv2code/contracts";
import { KeyRoundIcon, Volume2Icon } from "lucide-react";
import { useCallback, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  parseTextToSpeechSpeed,
  textToSpeechApiKeyClearPatch,
  textToSpeechApiKeyReplacementPatch,
} from "./SpeechSettingsPanel.logic";
import { searchableSetting } from "./settingsSearch";
import { VoiceControllerSettings } from "./VoiceControllerSettings";

const defaults = DEFAULT_SERVER_SETTINGS.textToSpeech;

export function SpeechSettingsPanel() {
  const settings = usePrimarySettings((value) => value.textToSpeech);
  const updateSettings = useUpdatePrimarySettings();
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  const updateSpeech = useCallback(
    (patch: Partial<typeof settings>) => updateSettings({ textToSpeech: patch }),
    [updateSettings],
  );
  const commitApiKey = useCallback(() => {
    const patch = textToSpeechApiKeyReplacementPatch(apiKeyDraft);
    if (patch) {
      updateSettings(patch);
      setApiKeyDraft("");
    }
  }, [apiKeyDraft, updateSettings]);

  return (
    <SettingsPageContainer>
      <VoiceControllerSettings />

      <SettingsSection
        id={searchableSetting("speech").id}
        title="Speech"
        icon={<Volume2Icon className="size-5" />}
      >
        <SettingsRow
          title="Text-to-speech"
          description="Enable manual read-aloud controls for completed agent messages."
          resetAction={
            settings.enabled !== defaults.enabled ? (
              <SettingResetButton
                label="text-to-speech"
                onClick={() => updateSpeech({ enabled: defaults.enabled })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => updateSpeech({ enabled: Boolean(enabled) })}
              aria-label="Enable text-to-speech"
            />
          }
        />

        <SettingsRow
          title="Speech endpoint"
          description="Full URL of an OpenAI-compatible /v1/audio/speech endpoint."
          resetAction={
            settings.endpoint !== defaults.endpoint ? (
              <SettingResetButton
                label="speech endpoint"
                onClick={() => updateSpeech({ endpoint: defaults.endpoint })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-96"
              value={settings.endpoint}
              onCommit={(endpoint) => updateSpeech({ endpoint })}
              placeholder="http://127.0.0.1:8880/v1/audio/speech"
              spellCheck={false}
              aria-label="OpenAI-compatible speech endpoint"
            />
          }
        />

        <SettingsRow
          title="API key"
          description="Optional Bearer token. It is stored by the server and never returned to the browser."
          status={settings.apiKeyRedacted ? "A key is saved." : "No key is saved."}
          resetAction={
            settings.apiKeyRedacted ? (
              <SettingResetButton
                label="speech API key"
                onClick={() => updateSettings(textToSpeechApiKeyClearPatch())}
              />
            ) : null
          }
          control={
            <div className="flex w-full gap-2 sm:w-96">
              <Input
                type="password"
                autoComplete="off"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                onBlur={commitApiKey}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                placeholder={settings.apiKeyRedacted ? "Replace saved key" : "Optional"}
                aria-label="Speech API key"
              />
              {settings.apiKeyRedacted ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => updateSettings(textToSpeechApiKeyClearPatch())}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          }
        />

        <SettingsRow
          title="Model"
          description="Model name sent in the OpenAI speech request."
          resetAction={
            settings.model !== defaults.model ? (
              <SettingResetButton
                label="speech model"
                onClick={() => updateSpeech({ model: defaults.model })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-64"
              value={settings.model}
              onCommit={(model) => updateSpeech({ model })}
              placeholder="tts-1"
              spellCheck={false}
              aria-label="Speech model"
            />
          }
        />

        <SettingsRow
          title="Voice"
          description="OpenAI voice alias or provider-specific voice identifier."
          resetAction={
            settings.voice !== defaults.voice ? (
              <SettingResetButton
                label="speech voice"
                onClick={() => updateSpeech({ voice: defaults.voice })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-64"
              value={settings.voice}
              onCommit={(voice) => updateSpeech({ voice })}
              placeholder="alloy"
              spellCheck={false}
              aria-label="Speech voice"
            />
          }
        />

        <SettingsRow
          title="Response format"
          description="Audio format requested from the provider, such as mp3, wav, opus, aac, or flac."
          resetAction={
            settings.responseFormat !== defaults.responseFormat ? (
              <SettingResetButton
                label="speech response format"
                onClick={() => updateSpeech({ responseFormat: defaults.responseFormat })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-40"
              value={settings.responseFormat}
              onCommit={(responseFormat) => updateSpeech({ responseFormat })}
              placeholder="mp3"
              spellCheck={false}
              aria-label="Speech response format"
            />
          }
        />

        <SettingsRow
          title="Speed"
          description={`Playback speed sent to the provider (${MIN_TEXT_TO_SPEECH_SPEED}–${MAX_TEXT_TO_SPEECH_SPEED}).`}
          resetAction={
            settings.speed !== defaults.speed ? (
              <SettingResetButton
                label="speech speed"
                onClick={() => updateSpeech({ speed: defaults.speed })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-32"
              type="number"
              min={MIN_TEXT_TO_SPEECH_SPEED}
              max={MAX_TEXT_TO_SPEECH_SPEED}
              step={0.05}
              value={String(settings.speed)}
              onCommit={(value) => {
                const speed = parseTextToSpeechSpeed(value);
                if (speed !== null) updateSpeech({ speed });
              }}
              aria-label="Speech speed"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Provider contract" icon={<KeyRoundIcon className="size-5" />}>
        <SettingsRow
          title="OpenAI Audio API"
          description="shuv2code sends model, voice, input, response_format, and speed from the server. It does not require an OpenAI account or SDK."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
