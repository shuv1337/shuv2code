import {
  WS_METHODS,
  type EnvironmentId,
  type VoiceAppendAudioInput,
  type VoiceEnsureControllerInput,
  type VoiceGetControllerInput,
  type VoiceGetControllerHistoryInput,
  type VoiceListVoicesInput,
  type VoiceRealtimeIngressInput,
  type VoiceResetControllerInput,
  type VoiceSessionStartInput,
  type VoiceSessionStopInput,
  type VoiceSubscribeEventsInput,
} from "@shuv2code/contracts";

import { request, subscribe } from "../rpc/client.ts";

export interface RealtimeVoiceGenerationIdentity {
  readonly clientSessionId: string;
  readonly generation: number;
}

export interface RealtimeVoiceGenerationTarget extends RealtimeVoiceGenerationIdentity {
  readonly environmentId: EnvironmentId;
}

export function nextRealtimeVoiceGeneration(
  current: RealtimeVoiceGenerationIdentity | null,
  newClientSessionId: () => string,
): RealtimeVoiceGenerationIdentity {
  return current === null
    ? { clientSessionId: newClientSessionId(), generation: 1 }
    : { clientSessionId: current.clientSessionId, generation: current.generation + 1 };
}

export function isMatchingRealtimeVoiceGeneration(
  expected: RealtimeVoiceGenerationIdentity,
  candidate: RealtimeVoiceGenerationIdentity,
): boolean {
  return (
    expected.clientSessionId === candidate.clientSessionId &&
    expected.generation === candidate.generation
  );
}

/**
 * Reconnects always negotiate a fresh transport generation. The returned
 * identity intentionally contains no utterance, transcript, or mutation
 * payload, so callers cannot accidentally replay recognized input.
 */
export function reconnectRealtimeVoiceGeneration(
  target: RealtimeVoiceGenerationTarget,
): RealtimeVoiceGenerationTarget {
  return { ...target, generation: target.generation + 1 };
}

export class RealtimeVoiceLeaseRelease {
  #released = false;
  #inFlight: Promise<void> | null = null;

  get released(): boolean {
    return this.#released;
  }

  markReleased(): void {
    this.#released = true;
  }

  async run(release: () => Promise<void>): Promise<boolean> {
    if (this.#released) {
      return false;
    }
    if (this.#inFlight) {
      await this.#inFlight;
      return false;
    }
    const inFlight = release();
    this.#inFlight = inFlight;
    try {
      await inFlight;
      this.#released = true;
      return true;
    } finally {
      if (this.#inFlight === inFlight) {
        this.#inFlight = null;
      }
    }
  }
}

export const ensureVoiceController = (input: VoiceEnsureControllerInput) =>
  request(WS_METHODS.voiceEnsureController, input);

export const getVoiceController = (input: VoiceGetControllerInput) =>
  request(WS_METHODS.voiceGetController, input);

export const getVoiceControllerHistory = (input: VoiceGetControllerHistoryInput) =>
  request(WS_METHODS.voiceGetControllerHistory, input);

export const listRealtimeVoices = (input: VoiceListVoicesInput) =>
  request(WS_METHODS.voiceListVoices, input);

export const startRealtimeVoice = (input: VoiceSessionStartInput) =>
  request(WS_METHODS.voiceStart, input);

export const ingestRealtimeVoiceEvent = (input: VoiceRealtimeIngressInput) =>
  request(WS_METHODS.voiceIngestRealtimeEvent, input);

export const appendRealtimeVoiceAudio = (input: VoiceAppendAudioInput) =>
  request(WS_METHODS.voiceAppendAudio, input);

export const stopRealtimeVoice = (input: VoiceSessionStopInput) =>
  request(WS_METHODS.voiceStop, input);

export const resetVoiceController = (input: VoiceResetControllerInput) =>
  request(WS_METHODS.voiceResetController, input);

export const subscribeRealtimeVoiceEvents = (
  input: VoiceSubscribeEventsInput,
): ReturnType<typeof subscribe<typeof WS_METHODS.subscribeVoiceEvents>> =>
  subscribe(WS_METHODS.subscribeVoiceEvents, input);

export function withoutRealtimeVoiceEventReplay(
  input: VoiceSubscribeEventsInput,
): VoiceSubscribeEventsInput {
  const { afterSequence: _, ...fence } = input;
  return fence;
}
