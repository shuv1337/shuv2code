import type { VoiceTargetPhase } from "@shuv2code/contracts";

export const PROACTIVE_SPEECH_MAX_CHARS = 512;
export const PROACTIVE_SPEECH_COOLDOWN_MS = 2_500;

const SPEAKABLE_TARGET_PHASES = new Set<VoiceTargetPhase>([
  "completed",
  "failed",
  "interrupted",
  "waiting_for_approval",
  "waiting_for_input",
  "stale",
]);

export type ProactiveSpeechKind =
  | "controller_action_completed"
  | "controller_action_failed"
  | "target_phase";

export interface ProactiveSpeechDecision {
  readonly speak: boolean;
  readonly text: string;
  readonly reason:
    | "speak"
    | "empty"
    | "duplicate"
    | "cooldown"
    | "phase_not_speakable"
    | "generation_mismatch";
}

export interface ProactiveSpeechMemoryEntry {
  readonly key: string;
  readonly text: string;
  readonly spokenAtMs: number;
  readonly generation: number;
}

export const boundProactiveSpeechText = (text: string): string =>
  text.trim().replace(/\s+/g, " ").slice(0, PROACTIVE_SPEECH_MAX_CHARS);

export const isSpeakableTargetPhase = (phase: VoiceTargetPhase): boolean =>
  SPEAKABLE_TARGET_PHASES.has(phase);

export interface ProactiveSpeechIdentity {
  readonly kind: ProactiveSpeechKind;
  readonly transportSessionId: string;
  readonly generation: number;
  readonly voiceActionId?: string;
  readonly targetThreadId?: string;
  readonly phase?: VoiceTargetPhase;
}

export const proactiveSpeechKey = (input: ProactiveSpeechIdentity): string =>
  [
    input.kind,
    input.transportSessionId,
    String(input.generation),
    input.voiceActionId ?? "",
    input.targetThreadId ?? "",
    input.phase ?? "",
  ].join("\u0000");

/**
 * Pure policy for proactive transport speech. Always-safe text delivery is
 * separate; this only decides whether `appendTransportSpeech` may run.
 *
 * Speaks terminal controller outcomes and actionable target blockers. Rejects
 * empty text, non-speakable phases, stale generations, exact key duplicates,
 * and cooldown collisions on the same transport generation.
 */
export const decideProactiveSpeech = (input: {
  readonly kind: ProactiveSpeechKind;
  readonly text: string;
  readonly transportSessionId: string;
  readonly generation: number;
  readonly nowMs: number;
  readonly memory: ReadonlyMap<string, ProactiveSpeechMemoryEntry>;
  readonly voiceActionId?: string;
  readonly targetThreadId?: string;
  readonly phase?: VoiceTargetPhase;
  readonly expectedGeneration?: number;
}): ProactiveSpeechDecision => {
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== input.generation) {
    return { speak: false, text: "", reason: "generation_mismatch" };
  }
  if (input.kind === "target_phase" && input.phase !== undefined) {
    if (!isSpeakableTargetPhase(input.phase)) {
      return { speak: false, text: "", reason: "phase_not_speakable" };
    }
  }
  const text = boundProactiveSpeechText(input.text);
  if (text.length === 0) {
    return { speak: false, text: "", reason: "empty" };
  }
  const identity: ProactiveSpeechIdentity = {
    kind: input.kind,
    transportSessionId: input.transportSessionId,
    generation: input.generation,
    ...(input.voiceActionId !== undefined ? { voiceActionId: input.voiceActionId } : {}),
    ...(input.targetThreadId !== undefined ? { targetThreadId: input.targetThreadId } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
  };
  const key = proactiveSpeechKey(identity);
  const prior = input.memory.get(key);
  if (prior !== undefined && prior.text === text) {
    return { speak: false, text, reason: "duplicate" };
  }
  for (const entry of input.memory.values()) {
    if (
      entry.generation === input.generation &&
      entry.key.includes(input.transportSessionId) &&
      input.nowMs - entry.spokenAtMs < PROACTIVE_SPEECH_COOLDOWN_MS
    ) {
      // Allow a distinct controller terminal after a target phase only when
      // the key differs and enough time passed; cooldown blocks rapid repeats.
      if (prior === undefined && input.kind.startsWith("controller_action")) {
        // Controller terminal may interrupt cooldown for a different key after half window.
        if (input.nowMs - entry.spokenAtMs < PROACTIVE_SPEECH_COOLDOWN_MS / 2) {
          return { speak: false, text, reason: "cooldown" };
        }
      } else if (prior === undefined) {
        return { speak: false, text, reason: "cooldown" };
      }
    }
  }
  return { speak: true, text, reason: "speak" };
};

export const rememberProactiveSpeech = (
  memory: Map<string, ProactiveSpeechMemoryEntry>,
  input: {
    readonly kind: ProactiveSpeechKind;
    readonly text: string;
    readonly transportSessionId: string;
    readonly generation: number;
    readonly nowMs: number;
    readonly voiceActionId?: string;
    readonly targetThreadId?: string;
    readonly phase?: VoiceTargetPhase;
  },
): void => {
  const identity: ProactiveSpeechIdentity = {
    kind: input.kind,
    transportSessionId: input.transportSessionId,
    generation: input.generation,
    ...(input.voiceActionId !== undefined ? { voiceActionId: input.voiceActionId } : {}),
    ...(input.targetThreadId !== undefined ? { targetThreadId: input.targetThreadId } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
  };
  const key = proactiveSpeechKey(identity);
  memory.set(key, {
    key,
    text: input.text,
    spokenAtMs: input.nowMs,
    generation: input.generation,
  });
  // Bound memory: drop entries older than 2 minutes or when map grows large.
  if (memory.size > 256) {
    const cutoff = input.nowMs - 120_000;
    for (const [entryKey, entry] of memory) {
      if (entry.spokenAtMs < cutoff || entry.generation < input.generation) {
        memory.delete(entryKey);
      }
    }
  }
};
