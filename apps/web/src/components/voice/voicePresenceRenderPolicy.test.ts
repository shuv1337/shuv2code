// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { describe, expect, it } from "vitest";

import {
  INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE,
  isConstrainedWebGlRenderer,
  nextVoicePresencePerformanceState,
  voicePresenceFrameInterval,
  voicePresenceRenderPolicy,
  type VoicePresencePerformanceState,
  VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS,
  VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS,
  VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS,
} from "./voicePresenceRenderPolicy";

describe("voicePresenceRenderPolicy", () => {
  const visible = {
    documentVisible: true,
    presented: true,
    reducedMotion: false,
    softwareRenderer: false,
    performanceMode: "normal" as const,
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

  it("keeps a live cadence under transient performance degradation", () => {
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", performanceMode: "degraded" }),
    ).toBe("degraded");
    expect(voicePresenceFrameInterval("degraded")).toBe(VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS);
  });

  it("renders only invalidated frames for reduced motion and constrained renderers", () => {
    expect(voicePresenceRenderPolicy({ ...visible, phase: "speaking", reducedMotion: true })).toBe(
      "static",
    );
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", softwareRenderer: true }),
    ).toBe("static");
    expect(voicePresenceFrameInterval("static")).toBeNull();
  });

  it("pauses off-panel and resumes when the Voice tab is presented again", () => {
    expect(
      voicePresenceRenderPolicy({ ...visible, phase: "speaking", documentVisible: false }),
    ).toBe("paused");
    const hidden = voicePresenceRenderPolicy({ ...visible, phase: "speaking", presented: false });
    const restored = voicePresenceRenderPolicy({ ...visible, phase: "speaking", presented: true });

    expect(hidden).toBe("paused");
    expect(restored).toBe("active");
  });
});

describe("voice presence renderer safeguards", () => {
  it("recognizes common software WebGL renderers", () => {
    expect(isConstrainedWebGlRenderer("ANGLE (Google, Vulkan 1.3 SwiftShader Device)")).toBe(true);
    expect(isConstrainedWebGlRenderer("llvmpipe (LLVM 19.1.7, 256 bits)")).toBe(true);
    expect(isConstrainedWebGlRenderer("AMD Radeon RX 6600 XT")).toBe(false);
    expect(isConstrainedWebGlRenderer(null)).toBe(false);
  });

  it("requires sustained slow frames before lowering the live cadence", () => {
    let state = INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE;
    for (let index = 0; index < 5; index++) {
      state = nextVoicePresencePerformanceState(
        state,
        VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS + 60,
        VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS,
      );
    }
    expect(state.mode).toBe("normal");
    state = nextVoicePresencePerformanceState(
      state,
      VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS + 60,
      VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS,
    );
    expect(state.mode).toBe("degraded");
  });

  it("recovers the active cadence after a stable degraded interval", () => {
    let state: VoicePresencePerformanceState = {
      mode: "degraded",
      pressure: 6,
      healthyFrames: 0,
    };
    for (let index = 0; index < 23; index++) {
      state = nextVoicePresencePerformanceState(
        state,
        VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS + 4,
        VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS,
      );
    }
    expect(state.mode).toBe("degraded");
    state = nextVoicePresencePerformanceState(
      state,
      VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS + 4,
      VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS,
    );
    expect(state).toEqual(INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE);
  });

  it("does not recover while degraded frames remain unstable", () => {
    let state: VoicePresencePerformanceState = {
      mode: "degraded",
      pressure: 6,
      healthyFrames: 12,
    };
    state = nextVoicePresencePerformanceState(
      state,
      VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS + 40,
      VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS,
    );
    expect(state).toEqual({ mode: "degraded", pressure: 6, healthyFrames: 0 });
  });
});
