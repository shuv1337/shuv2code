import {
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
  type VoiceNarrationLevel,
} from "@shuv2code/contracts";

export interface VoiceNarrationPolicy {
  readonly level: VoiceNarrationLevel;
  readonly silenceIntervalMs: number | null;
  readonly prompt: ReadonlyArray<string>;
}

export interface VoiceNarrationCheckpoint {
  readonly key: string;
  readonly text: string;
}

export interface VoiceNarrationRuntimeState {
  readonly pending: VoiceNarrationCheckpoint | null;
  readonly lastNarratedKey: string | null;
  readonly lastNarratedText: string | null;
  readonly lastSpeechAtMs: number;
}

export interface VoiceNarrationDecision {
  readonly speak: boolean;
  readonly text: string;
  readonly reason: "quiet" | "idle" | "duplicate" | "cooldown" | "speak";
}

const POLICIES: Readonly<Record<VoiceNarrationLevel, VoiceNarrationPolicy>> = {
  quiet: {
    level: "quiet",
    silenceIntervalMs: null,
    prompt: [
      "Keep routine tool progress quiet. Do not add commentary merely to fill silence or narrate ordinary tool calls.",
      "Speak blockers, approval requests, and clarifying questions promptly.",
    ],
  },
  balanced: {
    level: "balanced",
    silenceIntervalMs: 30_000,
    prompt: [
      "Maintain conversational presence while you work by sending useful, concise commentary updates; the Call relays a bounded spoken version automatically.",
      "If work remains active through an extended silent interval of roughly thirty seconds, send one truthful commentary sentence about what you are checking, what you learned, or what you are waiting for. Do not repeat an unchanged status merely to fill silence.",
      "Speak blockers, approval requests, and clarifying questions promptly.",
    ],
  },
  conversational: {
    level: "conversational",
    silenceIntervalMs: 15_000,
    prompt: [
      "Maintain active conversational presence while you work. Send a short natural commentary update at meaningful changes of phase and before or after meaningful tool calls; never read raw tool names, arguments, code, or logs aloud.",
      "If work remains active through a silent interval of roughly fifteen seconds, send one truthful commentary sentence about what you are checking, what changed, or what you are waiting for. Do not repeat an unchanged status merely to fill silence.",
      "Speak blockers, approval requests, and clarifying questions promptly.",
    ],
  },
};

export const resolveVoiceNarrationPolicy = (level: VoiceNarrationLevel): VoiceNarrationPolicy =>
  POLICIES[level];

const toolProgressText = (
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): string => {
  switch (event.payload.itemType) {
    case "command_execution":
      return event.type === "item.completed"
        ? "That check has finished; I’m working through the result now."
        : "I’m running the next check now.";
    case "file_change":
      return event.type === "item.completed"
        ? "That code change is in; I’m checking what follows from it now."
        : "I’m making the next code change now.";
    case "web_search":
      return event.type === "item.completed"
        ? "I’ve finished checking those sources and I’m working through what they show."
        : "I’m checking the relevant sources now.";
    case "image_view":
      return event.type === "item.completed"
        ? "I’ve finished checking the visual details and I’m continuing from there."
        : "I’m checking the visual details now.";
    case "collab_agent_tool_call":
      return event.type === "item.completed"
        ? "That focused review is back and I’m working through it now."
        : "I’m gathering another focused perspective now.";
    default:
      return event.type === "item.completed"
        ? "That step has finished; I’m working through the result now."
        : "I’m working through the next step now.";
  }
};

export const voiceNarrationCheckpoint = (
  event: ProviderRuntimeEvent,
): VoiceNarrationCheckpoint | null => {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return null;
  }
  if (!isToolLifecycleItemType(event.payload.itemType)) return null;
  return {
    key: `${event.itemId ?? event.eventId}:${event.type}`,
    text: toolProgressText(event),
  };
};

export const initialVoiceNarrationRuntimeState = (nowMs: number): VoiceNarrationRuntimeState => ({
  pending: null,
  lastNarratedKey: null,
  lastNarratedText: null,
  lastSpeechAtMs: nowMs,
});

export const decideVoiceNarration = (input: {
  readonly policy: VoiceNarrationPolicy;
  readonly state: VoiceNarrationRuntimeState;
  readonly nowMs: number;
}): VoiceNarrationDecision => {
  const intervalMs = input.policy.silenceIntervalMs;
  if (intervalMs === null) return { speak: false, text: "", reason: "quiet" };
  const pending = input.state.pending;
  if (pending === null) return { speak: false, text: "", reason: "idle" };
  const normalizedPendingText = pending.text.trim().replaceAll(/\s+/g, " ").toLowerCase();
  const normalizedLastText = input.state.lastNarratedText
    ?.trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
  if (pending.key === input.state.lastNarratedKey || normalizedPendingText === normalizedLastText) {
    return { speak: false, text: pending.text, reason: "duplicate" };
  }
  if (input.nowMs - input.state.lastSpeechAtMs < intervalMs) {
    return { speak: false, text: pending.text, reason: "cooldown" };
  }
  return { speak: true, text: pending.text, reason: "speak" };
};
