import type { CSSProperties } from "react";

export type VoicePresencePhase = "idle" | "listening" | "thinking" | "speaking" | "muted";

export const VOICE_PHASE_RENDER_STATES = {
  idle: { accent: [0.66, 0.62, 0.54], energy: 0.16 },
  listening: { accent: [0.34, 0.57, 0.64], energy: 0.38 },
  thinking: { accent: [0.47, 0.43, 0.59], energy: 0.33 },
  speaking: { accent: [0.7, 0.53, 0.34], energy: 0.46 },
  muted: { accent: [0.42, 0.43, 0.44], energy: 0.06 },
} as const satisfies Record<
  VoicePresencePhase,
  { readonly accent: readonly [number, number, number]; readonly energy: number }
>;

const PHASE_PALETTE = {
  idle: {
    accent: "oklch(0.72 0.014 82)",
    highlight: "oklch(0.89 0.01 82)",
    shadow: "oklch(0.2 0.012 255)",
  },
  listening: {
    accent: "oklch(0.67 0.045 225)",
    highlight: "oklch(0.88 0.026 210)",
    shadow: "oklch(0.2 0.028 248)",
  },
  thinking: {
    accent: "oklch(0.64 0.04 286)",
    highlight: "oklch(0.86 0.022 292)",
    shadow: "oklch(0.19 0.025 280)",
  },
  speaking: {
    accent: "oklch(0.74 0.052 78)",
    highlight: "oklch(0.91 0.026 91)",
    shadow: "oklch(0.21 0.025 58)",
  },
  muted: {
    accent: "oklch(0.52 0.008 255)",
    highlight: "oklch(0.72 0.007 255)",
    shadow: "oklch(0.18 0.008 255)",
  },
} as const satisfies Record<
  VoicePresencePhase,
  { readonly accent: string; readonly highlight: string; readonly shadow: string }
>;

/** Shared phase tokens for both the presence renderer and its surrounding call UI. */
export function voicePhaseStyle(phase: VoicePresencePhase): CSSProperties {
  const palette = PHASE_PALETTE[phase];
  return {
    "--voice-accent": palette.accent,
    "--voice-highlight": palette.highlight,
    "--voice-shadow": palette.shadow,
  } as CSSProperties;
}
