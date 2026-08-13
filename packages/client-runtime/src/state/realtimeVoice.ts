import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceActionState,
  VoiceSessionOwner,
  VoiceUnsupportedCode,
} from "@shuv2code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  ensureVoiceController,
  getVoiceController,
  getVoiceControllerHistory,
  ingestRealtimeVoiceEvent,
  listRealtimeVoices,
  prepareRealtimeVoiceThreadCall,
  startRealtimeVoice,
  stopRealtimeVoice,
  resetVoiceController,
  setVoiceControllerTarget,
  subscribeRealtimeVoiceEvents,
} from "../operations/realtimeVoice.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import { Atom } from "effect/unstable/reactivity";

export type RealtimeVoiceActivity =
  | "listening"
  | "user-speaking"
  | "thinking"
  | "assistant-speaking";

export type RealtimeVoicePhase =
  | { readonly type: "idle" }
  | { readonly type: "requesting-permission" }
  | { readonly type: "negotiating" }
  | { readonly type: "connected"; readonly activity: RealtimeVoiceActivity }
  | { readonly type: "reconnecting"; readonly attempt: number }
  | { readonly type: "stopping" }
  | {
      readonly type: "unsupported";
      readonly code:
        | "insecure-context"
        | "media-devices-unavailable"
        | "webrtc-unavailable"
        | "data-channel-unavailable"
        | "pcm-unavailable"
        | "server-unsupported"
        | VoiceUnsupportedCode;
      readonly message: string;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };

export interface RealtimeVoiceControllerIdentity {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface RealtimeVoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectTitle: string | null;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly actionId: string | null;
  readonly accepted: boolean;
  readonly providerConfirmed: boolean;
  readonly activeTurnId: TurnId | null;
  readonly phase:
    | "accepted"
    | "starting"
    | "working"
    | "waiting-approval"
    | "waiting-input"
    | "completed"
    | "interrupted"
    | "failed"
    | "stale"
    | "ready"
    | "stopped";
  readonly statusText: string;
}

export interface RealtimeVoiceTranscriptItem {
  readonly id: string;
  readonly speaker: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
  readonly sequence: number;
}

export interface RealtimeVoiceControllerAction {
  readonly actionId: string;
  readonly sequence: number;
  readonly state: VoiceActionState;
  readonly statusText: string;
  readonly detailCode: string | null;
  readonly occurredAt: string;
}

export interface RealtimeVoiceSessionState {
  readonly clientSessionId: string | null;
  readonly generation: number;
  readonly environmentId: EnvironmentId | null;
  readonly owner: VoiceSessionOwner | null;
  readonly phase: RealtimeVoicePhase;
  readonly controller: RealtimeVoiceControllerIdentity | null;
  readonly activeTarget: RealtimeVoiceTarget | null;
  readonly controllerAction: RealtimeVoiceControllerAction | null;
  readonly transcript: ReadonlyArray<RealtimeVoiceTranscriptItem>;
  readonly muted: boolean;
  readonly lastEventSequence: number;
}

export const initialRealtimeVoiceState: RealtimeVoiceSessionState = {
  clientSessionId: null,
  generation: 0,
  environmentId: null,
  owner: null,
  phase: { type: "idle" },
  controller: null,
  activeTarget: null,
  controllerAction: null,
  transcript: [],
  muted: false,
  lastEventSequence: 0,
};

export type RealtimeVoiceStateEvent =
  | {
      readonly type: "attempt-started";
      readonly clientSessionId: string;
      readonly generation: number;
      readonly environmentId: EnvironmentId;
      readonly owner?: VoiceSessionOwner;
    }
  | { readonly type: "permission-requested"; readonly generation: number }
  | { readonly type: "negotiating"; readonly generation: number }
  | {
      readonly type: "connected";
      readonly generation: number;
      readonly controller: RealtimeVoiceControllerIdentity;
      readonly owner?: VoiceSessionOwner;
    }
  | {
      readonly type: "activity-changed";
      readonly generation: number;
      readonly activity: RealtimeVoiceActivity;
    }
  | {
      readonly type: "reconnecting";
      readonly generation: number;
      readonly attempt: number;
    }
  | { readonly type: "muted-changed"; readonly generation: number; readonly muted: boolean }
  | {
      readonly type: "transcript-updated";
      readonly generation: number;
      readonly item: RealtimeVoiceTranscriptItem;
    }
  | {
      readonly type: "target-updated";
      readonly generation: number;
      readonly sequence: number;
      readonly target: RealtimeVoiceTarget;
    }
  | {
      readonly type: "controller-action-updated";
      readonly generation: number;
      readonly sequence: number;
      readonly action: RealtimeVoiceControllerAction;
    }
  | {
      readonly type: "server-event-observed";
      readonly generation: number;
      readonly sequence: number;
    }
  | {
      readonly type: "unsupported";
      readonly generation: number;
      readonly code: Extract<RealtimeVoicePhase, { type: "unsupported" }>["code"];
      readonly message: string;
    }
  | {
      readonly type: "failed";
      readonly generation: number;
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    }
  | { readonly type: "stopping"; readonly generation: number }
  | { readonly type: "stopped"; readonly generation: number };

function isCurrentGeneration(
  state: RealtimeVoiceSessionState,
  event: RealtimeVoiceStateEvent,
): boolean {
  return event.type === "attempt-started" || event.generation === state.generation;
}

function upsertTranscriptItem(
  items: ReadonlyArray<RealtimeVoiceTranscriptItem>,
  item: RealtimeVoiceTranscriptItem,
): ReadonlyArray<RealtimeVoiceTranscriptItem> {
  const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
  if (currentIndex < 0) {
    return [...items, item].sort((left, right) => left.sequence - right.sequence);
  }
  const current = items[currentIndex];
  if (!current || current.sequence > item.sequence || current.final) {
    return items;
  }
  const next = [...items];
  next[currentIndex] = item;
  return next;
}

export function reduceRealtimeVoiceState(
  state: RealtimeVoiceSessionState,
  event: RealtimeVoiceStateEvent,
): RealtimeVoiceSessionState {
  if (!isCurrentGeneration(state, event)) {
    return state;
  }

  switch (event.type) {
    case "attempt-started":
      if (event.generation <= state.generation && state.clientSessionId !== null) {
        return state;
      }
      return {
        ...initialRealtimeVoiceState,
        clientSessionId: event.clientSessionId,
        generation: event.generation,
        environmentId: event.environmentId,
        owner: event.owner ?? null,
        phase: { type: "requesting-permission" },
      };
    case "permission-requested":
      return { ...state, phase: { type: "requesting-permission" } };
    case "negotiating":
      return { ...state, phase: { type: "negotiating" } };
    case "connected":
      return {
        ...state,
        phase: { type: "connected", activity: "listening" },
        controller: event.controller,
        owner: event.owner ?? state.owner,
      };
    case "activity-changed":
      if (state.phase.type !== "connected") {
        return state;
      }
      return { ...state, phase: { type: "connected", activity: event.activity } };
    case "reconnecting":
      return { ...state, phase: { type: "reconnecting", attempt: event.attempt } };
    case "muted-changed":
      return { ...state, muted: event.muted };
    case "transcript-updated":
      return { ...state, transcript: upsertTranscriptItem(state.transcript, event.item) };
    case "target-updated":
      if (event.sequence <= state.lastEventSequence) {
        return state;
      }
      return {
        ...state,
        activeTarget: event.target,
        lastEventSequence: event.sequence,
      };
    case "controller-action-updated":
      if (state.controllerAction !== null && event.sequence <= state.controllerAction.sequence) {
        return state;
      }
      return {
        ...state,
        controllerAction: event.action,
      };
    case "server-event-observed":
      return event.sequence <= state.lastEventSequence
        ? state
        : { ...state, lastEventSequence: event.sequence };
    case "unsupported":
      return {
        ...state,
        phase: { type: "unsupported", code: event.code, message: event.message },
      };
    case "failed":
      return {
        ...state,
        phase: {
          type: "error",
          code: event.code,
          message: event.message,
          recoverable: event.recoverable,
        },
      };
    case "stopping":
      return { ...state, phase: { type: "stopping" } };
    case "stopped":
      return {
        ...initialRealtimeVoiceState,
        generation: state.generation,
      };
  }
}

export function isRealtimeVoiceActive(state: RealtimeVoiceSessionState): boolean {
  return state.phase.type !== "idle" && state.phase.type !== "unsupported";
}

export function realtimeVoiceStateLabel(state: RealtimeVoiceSessionState): string {
  switch (state.phase.type) {
    case "idle":
      return "Voice control is off";
    case "requesting-permission":
      return "Requesting microphone permission";
    case "negotiating":
      return "Connecting voice control";
    case "connected":
      if (state.controllerAction?.state === "queued") {
        return "Voice request queued";
      }
      if (state.controllerAction?.state === "controller-starting") {
        return "Starting voice controller";
      }
      if (state.controllerAction?.state === "controller-working") {
        return "Voice controller is working";
      }
      switch (state.phase.activity) {
        case "listening":
          return state.muted ? "Voice control connected, microphone muted" : "Listening";
        case "user-speaking":
          return "Hearing you";
        case "thinking":
          return "Voice controller is thinking";
        case "assistant-speaking":
          return "Voice controller is speaking";
      }
    case "reconnecting":
      return "Reconnecting voice control";
    case "stopping":
      return "Ending voice control";
    case "unsupported":
    case "error":
      return state.phase.message;
  }
}

export function createRealtimeVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    getController: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:get-controller",
      execute: getVoiceController,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    getControllerHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:get-controller-history",
      execute: getVoiceControllerHistory,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    setControllerTarget: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:set-controller-target",
      execute: setVoiceControllerTarget,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    ensureController: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:ensure-controller",
      execute: ensureVoiceController,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    listVoices: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:list-voices",
      execute: listRealtimeVoices,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    prepareThreadCall: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:prepare-thread-call",
      execute: prepareRealtimeVoiceThreadCall,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    start: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:start",
      execute: startRealtimeVoice,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    ingestRealtimeEvent: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:ingest-realtime-event",
      execute: ingestRealtimeVoiceEvent,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    stop: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:stop",
      execute: stopRealtimeVoice,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    resetController: createEnvironmentCommand(runtime, {
      label: "environment-data:voice:reset-controller",
      execute: resetVoiceController,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    events: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice:events",
      subscribe: subscribeRealtimeVoiceEvents,
      idleTtlMs: 5_000,
    }),
  };
}
