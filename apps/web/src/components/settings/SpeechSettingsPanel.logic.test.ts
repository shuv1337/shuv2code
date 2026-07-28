import { describe, expect, it } from "vite-plus/test";

import {
  parseTextToSpeechSpeed,
  textToSpeechApiKeyClearPatch,
  textToSpeechApiKeyReplacementPatch,
} from "./SpeechSettingsPanel.logic";

describe("Speech settings", () => {
  it.each([
    ["0.25", 0.25],
    [" 1 ", 1],
    ["4", 4],
  ])("accepts a supported speed: %s", (value, expected) => {
    expect(parseTextToSpeechSpeed(value)).toBe(expected);
  });

  it.each(["", "not-a-number", "0.24", "4.01"])("rejects an invalid speed: %s", (value) => {
    expect(parseTextToSpeechSpeed(value)).toBeNull();
  });

  it("only creates secret replacement patches for non-empty input", () => {
    expect(textToSpeechApiKeyReplacementPatch("  sk-test  ")).toEqual({
      textToSpeech: {
        apiKey: "sk-test",
        apiKeyRedacted: false,
      },
    });
    expect(textToSpeechApiKeyReplacementPatch("   ")).toBeNull();
  });

  it("creates an explicit secret clear patch", () => {
    expect(textToSpeechApiKeyClearPatch()).toEqual({
      textToSpeech: {
        apiKey: "",
        apiKeyRedacted: false,
      },
    });
  });
});
