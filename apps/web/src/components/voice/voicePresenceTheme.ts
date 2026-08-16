import type { CSSProperties } from "react";

import {
  DEFAULT_VOICE_PRESENCE_IDENTITY,
  type VoicePresenceIdentity,
} from "./voicePresenceIdentity";

export type VoicePresencePhase = "idle" | "listening" | "thinking" | "speaking" | "muted";

export const VOICE_PHASE_RENDER_STATES = {
  idle: { energy: 0.16, pairMix: 0.5 },
  listening: { energy: 0.38, pairMix: 0.9 },
  thinking: { energy: 0.33, pairMix: 0.5 },
  speaking: { energy: 0.46, pairMix: 0.1 },
  muted: { energy: 0.06, pairMix: 0.5 },
} as const satisfies Record<
  VoicePresencePhase,
  { readonly energy: number; readonly pairMix: number }
>;

/** Shared phase tokens for both the presence renderer and its surrounding call UI. */
export function voicePhaseStyle(
  phase: VoicePresencePhase,
  identity: VoicePresenceIdentity = DEFAULT_VOICE_PRESENCE_IDENTITY,
): CSSProperties {
  const primaryShare = Math.round((1 - VOICE_PHASE_RENDER_STATES[phase].pairMix) * 100);
  const identityAccent = `color-mix(in oklab, ${identity.palette.primaryCss} ${primaryShare}%, ${identity.palette.secondaryCss})`;
  const accent =
    phase === "muted"
      ? `color-mix(in oklab, ${identityAccent} 24%, oklch(0.52 0.008 255))`
      : identityAccent;
  return {
    "--voice-primary": identity.palette.primaryCss,
    "--voice-secondary": identity.palette.secondaryCss,
    "--voice-accent": accent,
    "--voice-highlight": `color-mix(in oklab, ${accent} 38%, white)`,
    "--voice-shadow": `color-mix(in oklab, ${accent} 12%, oklch(0.18 0.008 255))`,
  } as CSSProperties;
}
