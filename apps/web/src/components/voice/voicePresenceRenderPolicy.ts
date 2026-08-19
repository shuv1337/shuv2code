import type { VoicePresencePhase } from "./voicePresenceTheme";

export type VoicePresenceRenderPolicy = "active" | "degraded" | "ambient" | "static" | "paused";

export type VoicePresencePerformanceMode = "normal" | "degraded";

export interface VoicePresencePerformanceState {
  readonly mode: VoicePresencePerformanceMode;
  readonly pressure: number;
  readonly healthyFrames: number;
}

export const VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS = 1_000 / 30;
export const VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS = 1_000 / 12;
export const VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS = 1_000 / 6;

const SLOW_FRAME_LAG_THRESHOLD_MS = 45;
const SLOW_FRAME_PRESSURE_LIMIT = 6;
const RECOVERY_FRAME_LAG_THRESHOLD_MS = 24;
const RECOVERY_HEALTHY_FRAME_LIMIT = 24;

export const INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE: VoicePresencePerformanceState = {
  mode: "normal",
  pressure: 0,
  healthyFrames: 0,
};

export function voicePresenceRenderPolicy(options: {
  readonly phase: VoicePresencePhase;
  readonly documentVisible: boolean;
  readonly presented: boolean;
  readonly reducedMotion: boolean;
  readonly softwareRenderer: boolean;
  readonly performanceMode: VoicePresencePerformanceMode;
}): VoicePresenceRenderPolicy {
  if (!options.documentVisible || !options.presented) return "paused";
  if (options.reducedMotion || options.softwareRenderer) return "static";
  if (options.phase === "idle" || options.phase === "muted") return "ambient";
  return options.performanceMode === "degraded" ? "degraded" : "active";
}

export function voicePresenceFrameInterval(policy: VoicePresenceRenderPolicy): number | null {
  if (policy === "active") return VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS;
  if (policy === "degraded") return VOICE_PRESENCE_DEGRADED_FRAME_INTERVAL_MS;
  if (policy === "ambient") return VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS;
  return null;
}

export function isConstrainedWebGlRenderer(renderer: string | null): boolean {
  return renderer !== null && /swiftshader|software|llvmpipe|softpipe/i.test(renderer);
}

export function nextVoicePresencePerformanceState(
  current: VoicePresencePerformanceState,
  frameIntervalMs: number,
  expectedIntervalMs: number,
): VoicePresencePerformanceState {
  const frameLagMs = Math.max(0, frameIntervalMs - expectedIntervalMs);

  if (current.mode === "degraded") {
    const healthyFrames =
      frameLagMs <= RECOVERY_FRAME_LAG_THRESHOLD_MS ? current.healthyFrames + 1 : 0;
    if (healthyFrames >= RECOVERY_HEALTHY_FRAME_LIMIT) {
      return INITIAL_VOICE_PRESENCE_PERFORMANCE_STATE;
    }
    return { mode: "degraded", pressure: current.pressure, healthyFrames };
  }

  const pressure =
    frameLagMs > SLOW_FRAME_LAG_THRESHOLD_MS
      ? Math.min(SLOW_FRAME_PRESSURE_LIMIT, current.pressure + 1)
      : Math.max(0, current.pressure - 0.25);
  if (pressure >= SLOW_FRAME_PRESSURE_LIMIT) {
    return { mode: "degraded", pressure, healthyFrames: 0 };
  }
  return { mode: "normal", pressure, healthyFrames: 0 };
}
