import { describe, expect, it } from "vite-plus/test";

import automationsSettingsSource from "./AutomationsSettings.tsx?raw";
import speechSettingsSource from "./SpeechSettingsPanel.tsx?raw";
import {
  searchableSetting,
  searchSettings,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("quit confirmation")).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
  });

  it("keeps shipped Automation and Speech surfaces discoverable", () => {
    expect(SETTINGS_SECTION_LABELS).toMatchObject({
      "/settings/automations": "Automations",
      "/settings/speech": "Speech",
    });
    expect(searchSettings("automations")).toContainEqual(
      expect.objectContaining({ id: "automations", to: "/settings/automations" }),
    );
    expect(searchSettings("speech")).toContainEqual(
      expect.objectContaining({ id: "speech", to: "/settings/speech" }),
    );
    expect(searchSettings("call narration")).toContainEqual(
      expect.objectContaining({ id: "call-narration", to: "/settings/speech" }),
    );
  });

  it("keeps recovered settings search results anchored in their panels", () => {
    expect(automationsSettingsSource).toContain('id={searchableSetting("automations").id}');
    expect(speechSettingsSource).toContain('id={searchableSetting("speech").id}');
  });
});
