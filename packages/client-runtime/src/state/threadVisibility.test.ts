import { describe, expect, it } from "vite-plus/test";

import { isUserFacingThreadPurpose, isUserFacingThreadShell } from "./threadVisibility.ts";

describe("thread visibility", () => {
  it("keeps standard and legacy unspecified thread purposes user-facing", () => {
    expect(isUserFacingThreadPurpose(undefined)).toBe(true);
    expect(isUserFacingThreadPurpose("standard")).toBe(true);
    expect(isUserFacingThreadShell({})).toBe(true);
    expect(isUserFacingThreadShell({ purpose: "standard" })).toBe(true);
  });

  it("hides managed Voice infrastructure", () => {
    expect(isUserFacingThreadPurpose("voice-controller")).toBe(false);
    expect(isUserFacingThreadPurpose("voice-transport")).toBe(false);
    expect(isUserFacingThreadShell({ purpose: "voice-controller" })).toBe(false);
    expect(isUserFacingThreadShell({ purpose: "voice-transport" })).toBe(false);
  });
});
