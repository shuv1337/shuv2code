// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings voice presence", () => {
  it("defaults to balanced thread variation with contextual tint", () => {
    const settings = decodeClientSettings({});

    expect(settings.voicePresenceVariation).toBe("balanced");
    expect(settings.voicePresenceContextTint).toBe(true);
  });

  it.each(["subtle", "balanced"] as const)(
    "accepts the %s variation",
    (variation: "subtle" | "balanced") => {
      expect(decodeClientSettingsPatch({ voicePresenceVariation: variation })).toEqual({
        voicePresenceVariation: variation,
      });
    },
  );

  it("rejects variation outside the deliberately small range", () => {
    expect(() => decodeClientSettingsPatch({ voicePresenceVariation: "expressive" })).toThrow();
  });
});
