import { CodexSettings, OpenCodeV2Settings, ProviderDriverKind } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OpenAI, OpenCodeIcon } from "../Icons";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("exposes opencodeV2 with its canonical user-facing metadata", () => {
    const driver = ProviderDriverKind.make("opencodeV2");
    const definition = getDriverOption(driver);

    expect(definition).toMatchObject({
      value: driver,
      label: "opencode2",
      icon: OpenCodeIcon,
      settingsSchema: OpenCodeV2Settings,
    });
    expect(DRIVER_OPTIONS).toContain(definition);
    expect(DRIVER_OPTION_BY_VALUE[driver]).toBe(definition);
  });

  it("exposes codex with its canonical user-facing metadata", () => {
    const driver = ProviderDriverKind.make("codex");

    expect(getDriverOption(driver)).toEqual({
      value: driver,
      label: "Codex",
      icon: OpenAI,
      settingsSchema: CodexSettings,
    });
  });

  it("returns undefined for stripped or unknown drivers", () => {
    expect(getDriverOption(ProviderDriverKind.make("claudeAgent"))).toBeUndefined();
    expect(getDriverOption(ProviderDriverKind.make("opencode"))).toBeUndefined();
    expect(getDriverOption(ProviderDriverKind.make("cursor"))).toBeUndefined();
    expect(getDriverOption(ProviderDriverKind.make("grok"))).toBeUndefined();
  });
});
