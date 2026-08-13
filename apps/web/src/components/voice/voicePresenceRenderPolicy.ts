import type { VoicePresencePhase } from "./voicePresenceTheme";

export type VoicePresenceRenderPolicy = "active" | "ambient" | "static" | "paused";

export const VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS = 1_000 / 30;
export const VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS = 1_000 / 6;

const SLOW_FRAME_THRESHOLD_MS = 80;
const SLOW_FRAME_PRESSURE_LIMIT = 6;

export function voicePresenceRenderPolicy(options: {
  readonly phase: VoicePresencePhase;
  readonly documentVisible: boolean;
  readonly surfaceVisible: boolean;
  readonly reducedMotion: boolean;
  readonly constrainedRenderer: boolean;
}): VoicePresenceRenderPolicy {
  if (!options.documentVisible || !options.surfaceVisible) return "paused";
  if (options.reducedMotion || options.constrainedRenderer) return "static";
  return options.phase === "idle" || options.phase === "muted" ? "ambient" : "active";
}

export function voicePresenceFrameInterval(policy: VoicePresenceRenderPolicy): number | null {
  if (policy === "active") return VOICE_PRESENCE_ACTIVE_FRAME_INTERVAL_MS;
  if (policy === "ambient") return VOICE_PRESENCE_AMBIENT_FRAME_INTERVAL_MS;
  return null;
}

export function isConstrainedWebGlRenderer(renderer: string | null): boolean {
  return renderer !== null && /swiftshader|software|llvmpipe|softpipe/i.test(renderer);
}

export function nextSlowFramePressure(current: number, frameIntervalMs: number): number {
  if (frameIntervalMs > SLOW_FRAME_THRESHOLD_MS) {
    return Math.min(SLOW_FRAME_PRESSURE_LIMIT, current + 1);
  }
  return Math.max(0, current - 0.25);
}

export function hasSustainedFramePressure(pressure: number): boolean {
  return pressure >= SLOW_FRAME_PRESSURE_LIMIT;
}
