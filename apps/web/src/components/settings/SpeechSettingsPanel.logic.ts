import {
  MAX_TEXT_TO_SPEECH_SPEED,
  MIN_TEXT_TO_SPEECH_SPEED,
  type ServerSettingsPatch,
} from "@shuv2code/contracts";

export function parseTextToSpeechSpeed(value: string): number | null {
  const speed = Number(value.trim());
  return Number.isFinite(speed) &&
    speed >= MIN_TEXT_TO_SPEECH_SPEED &&
    speed <= MAX_TEXT_TO_SPEECH_SPEED
    ? speed
    : null;
}

export function textToSpeechApiKeyReplacementPatch(apiKey: string): ServerSettingsPatch | null {
  const normalized = apiKey.trim();
  return normalized.length > 0
    ? {
        textToSpeech: {
          apiKey: normalized,
          apiKeyRedacted: false,
        },
      }
    : null;
}

export function textToSpeechApiKeyClearPatch(): ServerSettingsPatch {
  return {
    textToSpeech: {
      apiKey: "",
      apiKeyRedacted: false,
    },
  };
}
