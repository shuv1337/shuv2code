import { describe, expect, it } from "vite-plus/test";

import { shouldRendererHostPreview } from "./backgroundTabHosting";

describe("shouldRendererHostPreview", () => {
  it("keeps unattended background guests out of the renderer DOM", () => {
    expect(shouldRendererHostPreview("background", false)).toBe(false);
  });

  it("allows an explicit human presentation to adopt a background guest", () => {
    expect(shouldRendererHostPreview("background", true)).toBe(true);
  });

  it("continues mounting ordinary renderer and unbound tabs", () => {
    expect(shouldRendererHostPreview("renderer", false)).toBe(true);
    expect(shouldRendererHostPreview("unbound", false)).toBe(true);
  });
});
