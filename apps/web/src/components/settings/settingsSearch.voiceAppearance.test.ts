// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";

import { searchableSetting, searchSettings } from "./settingsSearch";

describe("Call appearance settings search", () => {
  it("routes Call appearance to Speech settings", () => {
    expect(searchableSetting("call-appearance")).toEqual({
      id: "call-appearance",
      title: "Call appearance",
    });
    expect(searchSettings("call appearance")).toEqual([
      expect.objectContaining({ id: "call-appearance", to: "/settings/speech" }),
    ]);
  });
});
