import { OpenCodeSettings, OpenCodeV2Settings, ProviderDriverKind } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OpenCodeIcon } from "../Icons";
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

  it("preserves the existing OpenCode v1 metadata", () => {
    const driver = ProviderDriverKind.make("opencode");

    expect(getDriverOption(driver)).toEqual({
      value: driver,
      label: "OpenCode",
      icon: OpenCodeIcon,
      settingsSchema: OpenCodeSettings,
    });
  });
});
