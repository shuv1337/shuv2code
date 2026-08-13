// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";

import {
  hasSustainedFramePressure,
  isConstrainedWebGlRenderer,
  nextSlowFramePressure,
  voicePresenceFrameInterval,
  voicePresenceRenderPolicy,
  VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS,
  VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS,
} from "./voicePresenceRenderPolicy";

describe("voicePresenceRenderPolicy", () => {
  const visible = {
    documentVisible: true,
    surfaceVisible: true,
    reducedMotion: false,
    constrainedRenderer: false,
  } as const;

  it("uses active cadence only for conversational phases", () => {
    expect(voicePresenceRenderPolicy({ ...visible, phase: "listening" })).toBe("active");
    expect(voicePresenceRenderPolicy({ ...visible, phase: "thinking" })).toBe("active");
    expect(voicePresenceRenderPolicy({ ...visible, phase: "speaking" })).toBe("active");
    expect(voicePresenceFrameInterval("active")).toBe(VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS);
  });

  it("uses a low ambient cadence while idle or muted", () => {
    expect(voicePresenceRenderPolicy({ ...visible, phase: "idle" })).toBe("ambient");
    expect(voicePresenceRenderPolicy({ ...visible, phase: "muted" })).toBe("ambient");
    expect(voicePresenceFrameInterval("ambient")).toBe(VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS);
  });

  it("renders only invalidated frames for reduced motion and constrained renderers", () => {
    expect(voicePresenceRenderPolicy({ ...visible, phase: "speaking", reducedMotion: true })).toBe(
      "static",
    );
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", constrainedRenderer: true }),
    ).toBe("static");
    expect(voicePresenceFrameInterval("static")).toBeNull();
  });

  it("pauses when the page or presence is not visible", () => {
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", documentVisible: false }),
    ).toBe("paused");
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", surfaceVisible: false }),
    ).toBe("paused");
  });
});

describe("voice presence renderer safeguards", () => {
  it("recognizes common software WebGL renderers", () => {
    expect(isConstrainedWebGlRenderer("ANGLE (Google, Vulkan 1.3 SwiftShader Device)")).toBe(true);
    expect(isConstrainedWebGlRenderer("llvmpipe (LLVM 19.1.7, 256 bits)")).toBe(true);
    expect(isConstrainedWebGlRenderer("AMD Radeon RX 6600 XT")).toBe(false);
    expect(isConstrainedWebGlRenderer(null)).toBe(false);
  });

  it("requires sustained slow frames before degrading to static rendering", () => {
    let pressure = 0;
    for (let index = 0; index < 5; index++) pressure = nextSlowFramePressure(pressure, 100);
    expect(hasSustainedFramePressure(pressure)).toBe(false);
    pressure = nextSlowFramePressure(pressure, 100);
    expect(hasSustainedFramePressure(pressure)).toBe(true);
    expect(nextSlowFramePressure(pressure, 16)).toBeLessThan(pressure);
  });
});
