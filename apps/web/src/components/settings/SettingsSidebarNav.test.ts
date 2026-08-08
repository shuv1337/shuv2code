import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("includes every shipped custom settings surface in product order", () => {
    expect(SETTINGS_NAV_ITEMS.map(({ label, to }) => ({ label, to }))).toEqual([
      { label: "General", to: "/settings/general" },
      { label: "Appearance", to: "/settings/appearance" },
      { label: "Keybindings", to: "/settings/keybindings" },
      { label: "Providers", to: "/settings/providers" },
      { label: "Automations", to: "/settings/automations" },
      { label: "Speech", to: "/settings/speech" },
      { label: "Source Control", to: "/settings/source-control" },
      { label: "Connections", to: "/settings/connections" },
      { label: "Beta", to: "/settings/beta" },
      { label: "Archive", to: "/settings/archived" },
    ]);
  });
});
