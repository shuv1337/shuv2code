export type VoicePresenceRgb = readonly [number, number, number];

export interface VoicePresencePalette {
  readonly primary: VoicePresenceRgb;
  readonly secondary: VoicePresenceRgb;
  readonly primaryCss: string;
  readonly secondaryCss: string;
}

export interface VoicePresenceMorphology {
  readonly flowSpeed: number;
  readonly vorticity: number;
  readonly turbulence: number;
  readonly curl: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly scale: number;
  readonly tilt: number;
  readonly spread: number;
  readonly detail: number;
}

export interface VoicePresenceIdentity {
  readonly version: 1;
  readonly code: string;
  readonly provisional: boolean;
  readonly providerColor: string;
  readonly projectColor: string;
  readonly palette: VoicePresencePalette;
  readonly morphology: VoicePresenceMorphology;
}

export interface VoicePresenceIdentityInput {
  readonly threadId: string | null;
  readonly providerKey?: string | null;
  readonly projectKey?: string | null;
  readonly contextTint?: boolean;
  readonly variation?: VoicePresenceVariation;
}

interface IdentityPaletteSource {
  readonly primary: VoicePresenceRgb;
  readonly secondary: VoicePresenceRgb;
}

// A deliberately small family of calm pairings. The thread chooses the family;
// provider and project colors only tint it, so changing model configuration does
// not replace the thread's recognizable visual structure.
const IDENTITY_PALETTES: readonly IdentityPaletteSource[] = [
  { primary: [0.72, 0.56, 0.28], secondary: [0.88, 0.82, 0.65] },
  { primary: [0.22, 0.48, 0.68], secondary: [0.28, 0.68, 0.58] },
  { primary: [0.55, 0.32, 0.72], secondary: [0.2, 0.64, 0.72] },
  { primary: [0.65, 0.35, 0.2], secondary: [0.18, 0.59, 0.5] },
  { primary: [0.73, 0.27, 0.52], secondary: [0.28, 0.25, 0.66] },
  { primary: [0.32, 0.72, 0.6], secondary: [0.63, 0.44, 0.78] },
] as const;

const FLAVOR_COLORS: readonly VoicePresenceRgb[] = [
  [0.55, 0.32, 0.72],
  [0.86, 0.43, 0.12],
  [0.86, 0.7, 0.12],
  [0.12, 0.7, 0.68],
  [0.34, 0.57, 0.64],
  [0.7, 0.53, 0.34],
] as const;

const DEFAULT_PROVIDER_COLOR: VoicePresenceRgb = [0.55, 0.32, 0.72];

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function makeRandom(seed: number): () => number {
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function between(random: () => number, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random();
}

function clampChannel(value: number): number {
  return Math.min(0.94, Math.max(0.06, value));
}

function mixColor(
  base: VoicePresenceRgb,
  tint: VoicePresenceRgb,
  amount: number,
): VoicePresenceRgb {
  return [
    clampChannel(base[0] * (1 - amount) + tint[0] * amount),
    clampChannel(base[1] * (1 - amount) + tint[1] * amount),
    clampChannel(base[2] * (1 - amount) + tint[2] * amount),
  ];
}

function colorForKey(key: string | null | undefined, fallback: VoicePresenceRgb): VoicePresenceRgb {
  if (!key) return fallback;
  const normalized = key.toLowerCase();
  if (normalized.includes("codex") || normalized.includes("openai")) return DEFAULT_PROVIDER_COLOR;
  if (normalized.includes("claude") || normalized.includes("anthropic")) return [0.86, 0.43, 0.12];
  if (normalized.includes("cursor")) return [0.86, 0.7, 0.12];
  if (normalized.includes("opencode")) return [0.12, 0.7, 0.68];
  return FLAVOR_COLORS[hashSeed(key) % FLAVOR_COLORS.length] ?? fallback;
}

function rgbCss(color: VoicePresenceRgb): string {
  return `rgb(${color.map((channel) => Math.round(channel * 255)).join(" ")})`;
}

function varyFromNeutral(value: number, neutral: number, amount: number): number {
  return neutral + (value - neutral) * amount;
}

export function deriveVoicePresenceIdentity({
  threadId,
  providerKey,
  projectKey,
  contextTint = true,
  variation = "balanced",
}: VoicePresenceIdentityInput): VoicePresenceIdentity {
  const provisional = threadId === null;
  const stableSeed = threadId ?? `pending:${projectKey ?? "unknown-project"}`;
  const hash = hashSeed(`voice-presence:v1:${stableSeed}`);
  const random = makeRandom(hash);
  const base = IDENTITY_PALETTES[hash % IDENTITY_PALETTES.length] ?? IDENTITY_PALETTES[0]!;
  const providerColor = colorForKey(providerKey, DEFAULT_PROVIDER_COLOR);
  const projectColor = colorForKey(projectKey, base.primary);
  const primary = contextTint
    ? mixColor(mixColor(base.primary, providerColor, 0.08), projectColor, 0.05)
    : base.primary;
  const secondary = contextTint
    ? mixColor(mixColor(base.secondary, providerColor, 0.05), projectColor, 0.08)
    : base.secondary;
  const variationAmount = variation === "subtle" ? 0.46 : 1;
  const generatedMorphology: VoicePresenceMorphology = {
    flowSpeed: between(random, 0.86, 1.16),
    vorticity: between(random, 0.75, 1.35),
    turbulence: between(random, 0.85, 1.2),
    curl: between(random, 0.85, 1.15),
    positionX: between(random, -0.12, 0.12),
    positionY: between(random, -0.09, 0.09),
    scale: between(random, 0.92, 1.1),
    tilt: between(random, -0.18, 0.18),
    spread: between(random, 0.9, 1.12),
    detail: between(random, 0.85, 1.15),
  };

  return {
    version: 1,
    code: hash.toString(16).padStart(8, "0"),
    provisional,
    providerColor: rgbCss(providerColor),
    projectColor: rgbCss(projectColor),
    palette: {
      primary,
      secondary,
      primaryCss: rgbCss(primary),
      secondaryCss: rgbCss(secondary),
    },
    morphology: {
      flowSpeed: varyFromNeutral(generatedMorphology.flowSpeed, 1, variationAmount),
      vorticity: varyFromNeutral(generatedMorphology.vorticity, 1, variationAmount),
      turbulence: varyFromNeutral(generatedMorphology.turbulence, 1, variationAmount),
      curl: varyFromNeutral(generatedMorphology.curl, 1, variationAmount),
      positionX: generatedMorphology.positionX * variationAmount,
      positionY: generatedMorphology.positionY * variationAmount,
      scale: varyFromNeutral(generatedMorphology.scale, 1, variationAmount),
      tilt: generatedMorphology.tilt * variationAmount,
      spread: varyFromNeutral(generatedMorphology.spread, 1, variationAmount),
      detail: varyFromNeutral(generatedMorphology.detail, 1, variationAmount),
    },
  };
}

export const DEFAULT_VOICE_PRESENCE_IDENTITY = deriveVoicePresenceIdentity({
  threadId: "voice-presence-default",
  providerKey: "codex",
  projectKey: "shuv2code",
});
import type { VoicePresenceVariation } from "@shuv2code/contracts";
