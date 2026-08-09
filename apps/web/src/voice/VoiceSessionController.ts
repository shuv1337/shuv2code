import {
  VoiceClientSessionId,
  VoiceEventSequence,
  VoiceGeneration,
  VoiceTranscriptItemId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type VoiceControllerIdentity,
  type VoiceEnsureControllerInput,
  type VoiceEnsureControllerResult,
  type VoiceListVoicesInput,
  type VoiceAppendAudioInput,
  type VoiceAppendAudioResult,
  type VoiceListVoicesResult,
  type VoiceRealtimeIngressEvent,
  type VoiceRealtimeIngressInput,
  type VoiceRealtimeIngressResult,
  type VoiceSessionEvent,
  type VoiceSessionEventPayload,
  type VoiceSessionFence,
  type VoiceSessionStartInput,
  type VoiceSessionStartResult,
  type VoiceSessionStopInput,
  type VoiceSessionStopResult,
  type VoiceSubscribeEventsInput,
  type VoiceUnsupportedCode,
  VOICE_PCM_DEFAULT_CHANNELS,
  VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
} from "@shuv2code/contracts";
import {
  initialRealtimeVoiceState,
  reduceRealtimeVoiceState,
  type RealtimeVoiceSessionState,
  type RealtimeVoiceStateEvent,
  type RealtimeVoiceTarget,
} from "@shuv2code/client-runtime/state/realtime-voice";
import {
  RealtimeVoiceLeaseRelease,
  nextRealtimeVoiceGeneration,
} from "@shuv2code/client-runtime/operations/realtime-voice";

import { PcmVoiceTransport } from "./PcmVoiceTransport";
import { WebRtcVoiceTransport } from "./WebRtcVoiceTransport";
import { detectVoiceBrowserSupport, type VoiceBrowserSupport } from "./voiceBrowserSupport";
import { normalizeVoiceSessionError, VoiceSessionError } from "./voiceErrors";
import { releaseVoiceMicrophoneStream } from "./voiceMicrophoneAccess";
import { randomUUID } from "../lib/utils";

export interface VoiceSessionControllerApi {
  readonly ensureController: (
    environmentId: EnvironmentId,
    input: VoiceEnsureControllerInput,
  ) => Promise<VoiceEnsureControllerResult>;
  readonly listVoices: (
    environmentId: EnvironmentId,
    input: VoiceListVoicesInput,
  ) => Promise<VoiceListVoicesResult>;
  readonly setControllerTarget?: (
    environmentId: EnvironmentId,
    controllerThreadId: ThreadId,
    targetThreadId: ThreadId,
  ) => Promise<ThreadId>;
  readonly start: (
    environmentId: EnvironmentId,
    input: VoiceSessionStartInput,
  ) => Promise<VoiceSessionStartResult>;
  readonly ingestRealtimeEvent?: (
    environmentId: EnvironmentId,
    input: VoiceRealtimeIngressInput,
  ) => Promise<VoiceRealtimeIngressResult>;
  readonly appendAudio?: (
    environmentId: EnvironmentId,
    input: VoiceAppendAudioInput,
  ) => Promise<VoiceAppendAudioResult>;
  readonly stop: (
    environmentId: EnvironmentId,
    input: VoiceSessionStopInput,
  ) => Promise<VoiceSessionStopResult>;
  readonly subscribe: (
    environmentId: EnvironmentId,
    input: VoiceSubscribeEventsInput,
    onEvent: (event: VoiceSessionEvent) => void,
    onError: (error: unknown) => void,
  ) => () => void;
}

export interface StartVoiceSessionInput {
  readonly environmentId: EnvironmentId;
  readonly hostProjectId: ProjectId;
  readonly targetThreadId?: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection?: ModelSelection;
  readonly authorizedRuntimeCeiling: RuntimeMode;
  readonly voiceId?: string;
  readonly microphoneStream?: MediaStream;
}

export interface VoiceSessionControllerDependencies {
  readonly api: VoiceSessionControllerApi;
  readonly createTransport?: () => WebRtcVoiceTransport;
  readonly createPcmTransport?: (options: {
    readonly sampleRateHz: number;
    readonly channels: number;
    readonly onPcmChunk: (chunk: {
      readonly sequence: number;
      readonly audioBase64: string;
      readonly format: "pcm16";
      readonly sampleRateHz: number;
      readonly channels: number;
    }) => void | Promise<void>;
  }) => PcmVoiceTransport;
  readonly createClientSessionId?: () => string;
  readonly detectSupport?: () => VoiceBrowserSupport;
  readonly scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
}

type VoiceClientTranscriptDeltaEvent = {
  readonly type: "transcript.delta";
  readonly itemId: VoiceTranscriptItemId;
  readonly role: "user" | "assistant";
  readonly textDelta: string;
};

type VoiceClientDataChannelEvent = VoiceRealtimeIngressEvent | VoiceClientTranscriptDeltaEvent;

function defaultClientSessionId(): string {
  return randomUUID();
}

function controllerPresentation(environmentId: EnvironmentId, controller: VoiceControllerIdentity) {
  return {
    environmentId,
    projectId: controller.hostProjectId,
    threadId: controller.controllerThreadId,
    title: "Voice controller",
  } as const;
}

const SERVER_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "feature_disabled",
  "method_unavailable",
  "incompatible_version",
  "empty_voice_catalog",
  "webrtc_unavailable",
  "pcm_unavailable",
]);

function isServerUnsupportedCode(code: string): code is VoiceUnsupportedCode {
  return SERVER_UNSUPPORTED_CODES.has(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize only the bounded provider events needed by v1. The direct WebRTC
 * data channel is the authoritative source for client-managed v3 handoffs;
 * all other provider payloads stay in the browser and are discarded.
 */
export function parseRealtimeVoiceDataChannelEvent(
  data: string,
): VoiceClientDataChannelEvent | undefined {
  try {
    const message = JSON.parse(data) as unknown;
    if (!isRecord(message) || typeof message.type !== "string") return undefined;
    if (message.type === "input_transcript.added" || message.type === "output_transcript.added") {
      const item = message.item;
      const role = message.type === "input_transcript.added" ? "user" : "assistant";
      const expectedItemType = role === "user" ? "input_transcript" : "output_transcript";
      if (
        !isRecord(item) ||
        item.type !== expectedItemType ||
        typeof item.id !== "string" ||
        item.id.length === 0 ||
        item.id.length > 256 ||
        typeof item.text !== "string" ||
        item.text.length === 0 ||
        item.text.length > 16_384
      ) {
        return undefined;
      }
      return {
        type: "transcript.delta",
        itemId: VoiceTranscriptItemId.make(item.id),
        role,
        textDelta: item.text,
      };
    }
    if (message.type === "turn.done") {
      const turn = message.turn;
      if (
        !isRecord(turn) ||
        typeof turn.id !== "string" ||
        turn.id.length === 0 ||
        turn.id.length > 256 ||
        (turn.role !== "user" && turn.role !== "assistant") ||
        typeof turn.transcript !== "string" ||
        turn.transcript.length > 120_000
      ) {
        return undefined;
      }
      return {
        type: "transcript.done",
        itemId: VoiceTranscriptItemId.make(turn.id),
        role: turn.role,
        text: turn.transcript,
      } as VoiceRealtimeIngressEvent;
    }
    if (message.type !== "delegation.created") return undefined;
    const item = message.item;
    if (
      !isRecord(item) ||
      item.type !== "delegation" ||
      item.target !== "client" ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 256 ||
      !Array.isArray(item.content)
    ) {
      return undefined;
    }
    const transcript = item.content
      .filter(
        (part): part is { readonly type: "input_text"; readonly text: string } =>
          isRecord(part) && part.type === "input_text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (transcript.length === 0 || transcript.length > 120_000) return undefined;
    return {
      type: "handoff",
      handoffId: item.id,
      itemId: item.id,
      inputTranscript: transcript,
    };
  } catch {
    return undefined;
  }
}

export class VoiceSessionController {
  readonly #api: VoiceSessionControllerApi;
  readonly #createTransport: () => WebRtcVoiceTransport;
  readonly #createPcmTransport: NonNullable<
    VoiceSessionControllerDependencies["createPcmTransport"]
  >;
  readonly #createClientSessionId: () => string;
  readonly #detectSupport: () => VoiceBrowserSupport;
  readonly #scheduleRetry: (callback: () => void, delayMs: number) => () => void;
  readonly #listeners = new Set<(state: RealtimeVoiceSessionState) => void>();
  #state = initialRealtimeVoiceState;
  #transport: WebRtcVoiceTransport | PcmVoiceTransport | null = null;
  #unsubscribeEvents: (() => void) | null = null;
  #environmentId: EnvironmentId | null = null;
  #startInput: StartVoiceSessionInput | null = null;
  #controller: VoiceControllerIdentity | null = null;
  #fence: VoiceSessionFence | null = null;
  #release = new RealtimeVoiceLeaseRelease();
  #sessionIdentity: { readonly clientSessionId: string; readonly generation: number } | null = null;
  #reconnectPromise: Promise<void> | null = null;
  #cancelSubscriptionRetry: (() => void) | null = null;
  #subscriptionRetryAttempt = 0;
  #startInFlight: Promise<void> | null = null;
  #pendingTranscript = new Map<string, string>();
  #clientTranscriptDrafts = new Map<
    "user" | "assistant",
    { readonly id: string; readonly text: string }
  >();
  #clientTranscriptDraftSequence = 0;
  #clientTranscriptAuthoritative = false;
  #activeAction: {
    readonly actionId: string;
    readonly targetThreadId: RealtimeVoiceTarget["threadId"] | null;
    readonly accepted: boolean;
    readonly providerConfirmed: boolean;
  } | null = null;

  constructor(dependencies: VoiceSessionControllerDependencies) {
    this.#api = dependencies.api;
    this.#createTransport = dependencies.createTransport ?? (() => new WebRtcVoiceTransport());
    this.#createPcmTransport =
      dependencies.createPcmTransport ?? ((options) => new PcmVoiceTransport(options));
    this.#createClientSessionId = dependencies.createClientSessionId ?? defaultClientSessionId;
    this.#detectSupport = dependencies.detectSupport ?? detectVoiceBrowserSupport;
    this.#scheduleRetry =
      dependencies.scheduleRetry ??
      ((callback, delayMs) => {
        const timeout = globalThis.setTimeout(callback, delayMs);
        return () => globalThis.clearTimeout(timeout);
      });
  }

  get state(): RealtimeVoiceSessionState {
    return this.#state;
  }

  subscribe(listener: (state: RealtimeVoiceSessionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #dispatch(event: RealtimeVoiceStateEvent): void {
    const next = reduceRealtimeVoiceState(this.#state, event);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) {
      listener(next);
    }
  }

  #isStoppingOrIdle(): boolean {
    const phase = this.#state.phase.type;
    return phase === "idle" || phase === "stopping";
  }

  #isCurrentAttempt(clientSessionId: string, generation: number): boolean {
    const phase = this.#state.phase.type;
    return (
      this.#state.clientSessionId === clientSessionId &&
      this.#state.generation === generation &&
      phase !== "idle" &&
      phase !== "stopping" &&
      phase !== "error" &&
      phase !== "unsupported"
    );
  }

  async start(input: StartVoiceSessionInput): Promise<void> {
    if (this.#startInFlight) {
      releaseVoiceMicrophoneStream(input.microphoneStream);
      return this.#startInFlight;
    }
    const start = this.#start(input);
    this.#startInFlight = start;
    try {
      await start;
    } finally {
      if (this.#startInFlight === start) {
        this.#startInFlight = null;
      }
    }
  }

  async #start(input: StartVoiceSessionInput): Promise<void> {
    if (this.#state.phase.type !== "idle" && this.#state.phase.type !== "unsupported") {
      releaseVoiceMicrophoneStream(input.microphoneStream);
      return;
    }
    let microphoneStream = input.microphoneStream;
    const support = this.#detectSupport();
    const generationIdentity = nextRealtimeVoiceGeneration(
      this.#sessionIdentity,
      this.#createClientSessionId,
    );
    this.#sessionIdentity = generationIdentity;
    this.#dispatch({
      type: "attempt-started",
      clientSessionId: generationIdentity.clientSessionId,
      generation: generationIdentity.generation,
      environmentId: input.environmentId,
    });
    if (!support.supported) {
      releaseVoiceMicrophoneStream(microphoneStream);
      microphoneStream = undefined;
      this.#dispatch({
        type: "unsupported",
        generation: generationIdentity.generation,
        code: support.code,
        message: support.message,
      });
      return;
    }

    this.#environmentId = input.environmentId;
    const { microphoneStream: _microphoneStream, ...reconnectInput } = input;
    this.#startInput = reconnectInput;
    this.#release = new RealtimeVoiceLeaseRelease();
    try {
      const ensured = await this.#api.ensureController(input.environmentId, {
        hostProjectId: input.hostProjectId,
        providerInstanceId: input.providerInstanceId,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        authorizedRuntimeCeiling: input.authorizedRuntimeCeiling,
      });
      if (
        !this.#isCurrentAttempt(generationIdentity.clientSessionId, generationIdentity.generation)
      ) {
        return;
      }
      this.#controller = ensured.controller;
      if (input.targetThreadId !== undefined && this.#api.setControllerTarget !== undefined) {
        await this.#api.setControllerTarget(
          input.environmentId,
          ensured.controller.controllerThreadId,
          input.targetThreadId,
        );
      }
      if (
        !this.#isCurrentAttempt(generationIdentity.clientSessionId, generationIdentity.generation)
      ) {
        return;
      }
      const catalog = await this.#api.listVoices(input.environmentId, {
        controllerThreadId: ensured.controller.controllerThreadId,
      });
      if (
        !this.#isCurrentAttempt(generationIdentity.clientSessionId, generationIdentity.generation)
      ) {
        return;
      }
      const voiceId = input.voiceId ?? catalog.defaultVoiceId;
      if (voiceId === null) {
        throw new VoiceSessionError(
          "incompatible_version",
          "Codex realtime did not advertise a default v3-compatible voice.",
        );
      }
      if (!catalog.voices.some((voice) => voice.id === voiceId)) {
        throw new VoiceSessionError(
          "voice-unavailable",
          `The selected realtime voice '${voiceId}' is no longer available.`,
          true,
        );
      }
      this.#dispatch({ type: "permission-requested", generation: generationIdentity.generation });
      if (support.webrtc) {
        const transport = this.#createTransport();
        this.#transport = transport;
        const preparedMicrophone = microphoneStream;
        microphoneStream = undefined;
        await transport.connect(
          {
            exchangeOffer: async (offerSdp) => {
              this.#dispatch({ type: "negotiating", generation: generationIdentity.generation });
              const started = await this.#api.start(input.environmentId, {
                controllerThreadId: ensured.controller.controllerThreadId,
                clientSessionId: VoiceClientSessionId.make(generationIdentity.clientSessionId),
                generation: VoiceGeneration.make(generationIdentity.generation),
                transport: { type: "webrtc", offerSdp },
                voiceId,
              });
              if (
                started.clientSessionId !== generationIdentity.clientSessionId ||
                started.generation !== generationIdentity.generation
              ) {
                throw new VoiceSessionError(
                  "stale-generation",
                  "The voice server returned a stale session.",
                );
              }
              if (
                !this.#isCurrentAttempt(
                  generationIdentity.clientSessionId,
                  generationIdentity.generation,
                )
              ) {
                await this.#releaseLateStartedSession(
                  input.environmentId,
                  started,
                  generationIdentity.generation,
                );
                return started.answerSdp ?? "";
              }
              this.#bindStartedSession(input.environmentId, started);
              return started.answerSdp ?? "";
            },
            onData: (data) => this.#handleDataChannelMessage(data, generationIdentity.generation),
            onMicrophoneEnded: () => {
              void this.#fail(
                generationIdentity.generation,
                new VoiceSessionError(
                  "microphone-ended",
                  "The microphone became unavailable. Check the device and try again.",
                  true,
                ),
              );
            },
            onConnectionStateChange: (state) => {
              if (state === "failed" || state === "disconnected") {
                void this.reconnect();
              }
            },
          },
          preparedMicrophone,
        );
      } else if (support.pcm && this.#api.appendAudio !== undefined) {
        this.#dispatch({ type: "negotiating", generation: generationIdentity.generation });
        const started = await this.#api.start(input.environmentId, {
          controllerThreadId: ensured.controller.controllerThreadId,
          clientSessionId: VoiceClientSessionId.make(generationIdentity.clientSessionId),
          generation: VoiceGeneration.make(generationIdentity.generation),
          transport: {
            type: "websocket",
            inputAudio: {
              format: "pcm16",
              sampleRateHz: VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ,
              channels: VOICE_PCM_DEFAULT_CHANNELS,
            },
          },
          voiceId,
        });
        if (
          started.clientSessionId !== generationIdentity.clientSessionId ||
          started.generation !== generationIdentity.generation
        ) {
          throw new VoiceSessionError(
            "stale-generation",
            "The voice server returned a stale session.",
          );
        }
        if (
          !this.#isCurrentAttempt(generationIdentity.clientSessionId, generationIdentity.generation)
        ) {
          await this.#releaseLateStartedSession(
            input.environmentId,
            started,
            generationIdentity.generation,
          );
          return;
        }
        this.#bindStartedSession(input.environmentId, started);
        const sampleRateHz = started.inputAudio?.sampleRateHz ?? VOICE_PCM_DEFAULT_SAMPLE_RATE_HZ;
        const channels = started.inputAudio?.channels ?? VOICE_PCM_DEFAULT_CHANNELS;
        const appendAudio = this.#api.appendAudio;
        const transport = this.#createPcmTransport({
          sampleRateHz,
          channels,
          onPcmChunk: async (chunk) => {
            const fence = this.#fence;
            const environmentId = this.#environmentId;
            if (!fence || !environmentId || !appendAudio) return;
            if (
              !this.#isCurrentAttempt(
                generationIdentity.clientSessionId,
                generationIdentity.generation,
              )
            ) {
              return;
            }
            await appendAudio(environmentId, {
              ...fence,
              sequence: chunk.sequence,
              audioBase64: chunk.audioBase64,
              format: chunk.format,
              sampleRateHz: chunk.sampleRateHz,
              channels: chunk.channels,
            });
          },
        });
        this.#transport = transport;
        const preparedMicrophone = microphoneStream;
        microphoneStream = undefined;
        await transport.start(preparedMicrophone);
      } else {
        throw new VoiceSessionError(
          "webrtc-unavailable",
          "This browser does not support WebRTC or PCM voice fallback.",
        );
      }
      if (
        !this.#isCurrentAttempt(
          generationIdentity.clientSessionId,
          generationIdentity.generation,
        ) ||
        !this.#controller
      ) {
        this.#transport?.close();
        this.#transport = null;
        return;
      }
      this.#dispatch({
        type: "connected",
        generation: generationIdentity.generation,
        controller: controllerPresentation(input.environmentId, this.#controller),
      });
    } catch (error) {
      if (this.#isStoppingOrIdle()) {
        return;
      }
      const normalized = normalizeVoiceSessionError(error);
      if (isServerUnsupportedCode(normalized.code)) {
        this.#dispatch({
          type: "unsupported",
          generation: generationIdentity.generation,
          code: normalized.code,
          message: normalized.message,
        });
        await this.#releaseActiveResources().catch(() => undefined);
        return;
      }
      await this.#fail(generationIdentity.generation, normalized);
    } finally {
      releaseVoiceMicrophoneStream(microphoneStream);
    }
  }

  async #releaseLateStartedSession(
    environmentId: EnvironmentId,
    started: VoiceSessionStartResult,
    generation: number,
  ): Promise<void> {
    const fence: VoiceSessionFence = {
      controllerThreadId: started.controller.controllerThreadId,
      transportThreadId: started.transportThreadId,
      clientSessionId: started.clientSessionId,
      generation: started.generation,
      runtimeInstanceId: started.runtimeInstanceId,
      realtimeSessionId: started.realtimeSessionId,
    };
    try {
      await this.#release.run(() => this.#api.stop(environmentId, fence).then(() => undefined));
    } catch (error) {
      this.#environmentId = environmentId;
      this.#fence = fence;
      this.#dispatchStopFailure(generation, error);
    }
  }

  #bindStartedSession(environmentId: EnvironmentId, started: VoiceSessionStartResult): void {
    if (
      started.clientSessionId !== this.#state.clientSessionId ||
      started.generation !== this.#state.generation
    ) {
      throw new VoiceSessionError("stale-generation", "The voice server returned a stale session.");
    }
    this.#fence = {
      controllerThreadId: started.controller.controllerThreadId,
      transportThreadId: started.transportThreadId,
      clientSessionId: started.clientSessionId,
      generation: started.generation,
      runtimeInstanceId: started.runtimeInstanceId,
      realtimeSessionId: started.realtimeSessionId,
    };
    this.#subscribeToEvents(environmentId, {
      clientSessionId: started.clientSessionId,
      generation: started.generation,
      runtimeInstanceId: started.runtimeInstanceId,
      afterSequence: started.eventCursor,
    });
  }

  #subscribeToEvents(environmentId: EnvironmentId, input: VoiceSubscribeEventsInput): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = this.#api.subscribe(
      environmentId,
      input,
      (event) => {
        this.#subscriptionRetryAttempt = 0;
        if (this.#state.phase.type === "reconnecting" && this.#controller && this.#environmentId) {
          this.#dispatch({
            type: "connected",
            generation: this.#state.generation,
            controller: controllerPresentation(this.#environmentId, this.#controller),
          });
        }
        this.#handleServerEvent(event);
      },
      (error) => this.#handleSubscriptionError(error),
    );
  }

  #handleDataChannelMessage(data: string, generation: number): void {
    try {
      const message = JSON.parse(data) as { readonly type?: unknown; readonly message?: unknown };
      if (message.type === "client.playback-error") {
        void this.#fail(
          generation,
          new VoiceSessionError(
            "autoplay-blocked",
            typeof message.message === "string"
              ? `Audio playback was blocked: ${message.message}`
              : "Audio playback was blocked. Use the voice tray to try again.",
            true,
          ),
        );
        return;
      }
    } catch {
      return;
    }
    const event = parseRealtimeVoiceDataChannelEvent(data);
    const environmentId = this.#environmentId;
    const fence = this.#fence;
    if (
      event === undefined ||
      environmentId === null ||
      fence === null ||
      generation !== this.#state.generation
    ) {
      return;
    }
    if (event.type === "transcript.delta" || event.type === "transcript.done") {
      this.#handleClientTranscriptEvent(event, generation);
      if (event.type === "transcript.delta") {
        return;
      }
    }
    if (this.#api.ingestRealtimeEvent === undefined) {
      return;
    }
    void this.#api
      .ingestRealtimeEvent(environmentId, { ...fence, event })
      .catch((error) =>
        this.#fail(
          generation,
          new VoiceSessionError(
            "realtime-ingress-failed",
            "A realtime voice event could not be accepted. Reconnect voice control and try again.",
            true,
            { cause: error },
          ),
        ),
      );
  }

  #handleClientTranscriptEvent(
    event:
      | VoiceClientTranscriptDeltaEvent
      | Extract<VoiceRealtimeIngressEvent, { type: "transcript.done" }>,
    generation: number,
  ): void {
    this.#clientTranscriptAuthoritative = true;
    if (event.type === "transcript.delta") {
      const current = this.#clientTranscriptDrafts.get(event.role);
      const next = {
        id:
          current?.id ??
          `client:${event.role}:${(this.#clientTranscriptDraftSequence += 1).toString(36)}`,
        text: `${current?.text ?? ""}${event.textDelta}`,
      };
      this.#clientTranscriptDrafts.set(event.role, next);
      this.#dispatch({
        type: "transcript-updated",
        generation,
        item: {
          id: next.id,
          speaker: event.role,
          text: next.text,
          final: false,
          sequence: 0,
        },
      });
      return;
    }
    const current = this.#clientTranscriptDrafts.get(event.role);
    this.#clientTranscriptDrafts.delete(event.role);
    this.#dispatch({
      type: "transcript-updated",
      generation,
      item: {
        id: current?.id ?? event.itemId,
        speaker: event.role,
        text: event.text,
        final: true,
        sequence: 0,
      },
    });
  }

  #handleSubscriptionError(error: unknown): void {
    if (this.#state.phase.type === "stopping" || this.#state.phase.type === "idle") {
      return;
    }
    const environmentId = this.#environmentId;
    const fence = this.#fence;
    if (!environmentId || !fence) {
      return;
    }
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
    this.#cancelSubscriptionRetry?.();
    this.#subscriptionRetryAttempt += 1;
    if (this.#subscriptionRetryAttempt > 3) {
      const normalized = normalizeVoiceSessionError(error);
      void this.#fail(
        this.#state.generation,
        new VoiceSessionError(normalized.code, normalized.message, true, { cause: error }),
      );
      return;
    }
    const generation = this.#state.generation;
    this.#dispatch({
      type: "reconnecting",
      generation,
      attempt: this.#subscriptionRetryAttempt,
    });
    this.#cancelSubscriptionRetry = this.#scheduleRetry(
      () => {
        this.#cancelSubscriptionRetry = null;
        if (
          this.#state.generation !== generation ||
          this.#fence?.runtimeInstanceId !== fence.runtimeInstanceId
        ) {
          return;
        }
        this.#subscribeToEvents(environmentId, {
          clientSessionId: fence.clientSessionId,
          generation: fence.generation,
          runtimeInstanceId: fence.runtimeInstanceId,
          afterSequence: VoiceEventSequence.make(this.#state.lastEventSequence),
        });
      },
      Math.min(4_000, 250 * 2 ** (this.#subscriptionRetryAttempt - 1)),
    );
  }

  #handleServerEvent(event: VoiceSessionEvent): void {
    if (
      event.clientSessionId !== this.#state.clientSessionId ||
      event.generation !== this.#state.generation ||
      event.runtimeInstanceId !== this.#fence?.runtimeInstanceId ||
      event.sequence <= this.#state.lastEventSequence
    ) {
      return;
    }
    const generation = this.#state.generation;
    switch (event.payload.type) {
      case "session.state":
        if (
          event.payload.state === "listening" ||
          event.payload.state === "user-speaking" ||
          event.payload.state === "thinking" ||
          event.payload.state === "assistant-speaking"
        ) {
          this.#dispatch({
            type: "activity-changed",
            generation,
            activity: event.payload.state,
          });
        } else if (event.payload.state === "reconnecting") {
          this.#dispatch({ type: "reconnecting", generation, attempt: 1 });
        } else if (event.payload.state === "stopping") {
          this.#dispatch({ type: "stopping", generation });
        } else if (event.payload.state === "stopped") {
          this.#dispatch({
            type: "server-event-observed",
            generation,
            sequence: event.sequence,
          });
          this.#handleServerStopped(generation);
          return;
        }
        break;
      case "transcript.delta": {
        if (this.#clientTranscriptAuthoritative) {
          break;
        }
        const text = `${this.#pendingTranscript.get(event.payload.itemId) ?? ""}${event.payload.textDelta}`;
        this.#pendingTranscript.set(event.payload.itemId, text);
        this.#dispatch({
          type: "transcript-updated",
          generation,
          item: {
            id: event.payload.itemId,
            speaker: event.payload.role,
            text,
            final: false,
            sequence: event.sequence,
          },
        });
        break;
      }
      case "transcript.done":
        if (this.#clientTranscriptAuthoritative) {
          break;
        }
        this.#pendingTranscript.delete(event.payload.itemId);
        this.#dispatch({
          type: "transcript-updated",
          generation,
          item: {
            id: event.payload.itemId,
            speaker: event.payload.role,
            text: event.payload.text,
            final: true,
            sequence: event.sequence,
          },
        });
        break;
      case "action.status":
        this.#activeAction = {
          actionId: event.payload.voiceActionId,
          targetThreadId: event.payload.targetThreadId ?? null,
          accepted:
            event.payload.state === "accepted" ||
            event.payload.state === "provider-confirmed" ||
            event.payload.state === "completed",
          providerConfirmed:
            event.payload.state === "provider-confirmed" || event.payload.state === "completed",
        };
        this.#dispatch({
          type: "controller-action-updated",
          generation,
          sequence: event.sequence,
          action: {
            actionId: event.payload.voiceActionId,
            sequence: event.sequence,
            state: event.payload.state,
            statusText: event.payload.statusText ?? event.payload.state.replaceAll("-", " "),
            detailCode: event.payload.detailCode ?? null,
            occurredAt: event.occurredAt,
          },
        });
        if (event.payload.targetThreadId) {
          this.#dispatch({
            type: "target-updated",
            generation,
            sequence: event.sequence,
            target: this.#targetFromAction(event.payload),
          });
        }
        break;
      case "target.status":
        this.#dispatch({
          type: "target-updated",
          generation,
          sequence: event.sequence,
          target: this.#targetFromStatus(event.payload),
        });
        break;
      case "session.error":
        void this.#fail(
          generation,
          new VoiceSessionError(
            event.payload.code,
            `Voice control error: ${event.payload.code.replaceAll("_", " ")}.`,
            event.payload.retryable,
          ),
        );
        break;
    }
    this.#dispatch({
      type: "server-event-observed",
      generation,
      sequence: event.sequence,
    });
  }

  #targetFromAction(
    payload: Extract<VoiceSessionEventPayload, { readonly type: "action.status" }>,
  ): RealtimeVoiceTarget {
    return {
      environmentId: this.#environmentId!,
      projectId: payload.targetProjectId ?? null,
      projectTitle: payload.projectTitle ?? null,
      threadId: payload.targetThreadId!,
      threadTitle: payload.threadTitle ?? `Thread ${payload.targetThreadId}`,
      actionId: payload.voiceActionId,
      accepted: this.#activeAction?.accepted ?? false,
      providerConfirmed: this.#activeAction?.providerConfirmed ?? false,
      activeTurnId: null,
      phase:
        payload.state === "failed" || payload.state === "indeterminate"
          ? "failed"
          : payload.state === "stale"
            ? "stale"
            : payload.state === "completed"
              ? "completed"
              : payload.state === "provider-confirmed"
                ? "working"
                : "accepted",
      statusText: payload.statusText ?? payload.state.replaceAll("-", " "),
    };
  }

  #targetFromStatus(
    payload: Extract<VoiceSessionEventPayload, { readonly type: "target.status" }>,
  ): RealtimeVoiceTarget {
    const action = this.#activeAction;
    return {
      environmentId: this.#environmentId!,
      projectId: payload.targetProjectId,
      projectTitle: payload.projectTitle,
      threadId: payload.targetThreadId,
      threadTitle: payload.threadTitle,
      actionId: payload.voiceActionId,
      accepted: action !== null && action.actionId === payload.voiceActionId && action.accepted,
      providerConfirmed:
        action !== null && action.actionId === payload.voiceActionId && action.providerConfirmed,
      activeTurnId: payload.activeTurnId,
      phase:
        payload.phase === "waiting_for_approval"
          ? "waiting-approval"
          : payload.phase === "waiting_for_input"
            ? "waiting-input"
            : payload.phase,
      statusText: payload.statusText ?? payload.phase.replaceAll("_", " "),
    };
  }

  setMuted(muted: boolean): void {
    this.#transport?.setMuted(muted);
    this.#dispatch({ type: "muted-changed", generation: this.#state.generation, muted });
  }

  #releaseBrowserResources(): void {
    this.#cancelSubscriptionRetry?.();
    this.#cancelSubscriptionRetry = null;
    this.#subscriptionRetryAttempt = 0;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
    const transport = this.#transport;
    this.#transport = null;
    if (transport instanceof PcmVoiceTransport) {
      void transport.stop();
    } else {
      transport?.close();
    }
  }

  async #releaseActiveResources(): Promise<void> {
    this.#releaseBrowserResources();
    const environmentId = this.#environmentId;
    const fence = this.#fence;
    if (environmentId && fence) {
      await this.#release.run(() => this.#api.stop(environmentId, fence).then(() => undefined));
      if (this.#fence === fence) {
        this.#fence = null;
      }
    }
  }

  #dispatchStopFailure(generation: number, error: unknown): void {
    const normalized = normalizeVoiceSessionError(error);
    const existing = this.#state.phase.type === "error" ? this.#state.phase : null;
    this.#dispatch({
      type: "failed",
      generation,
      code: existing?.code ?? normalized.code,
      message: `${existing ? `${existing.message} ` : ""}Voice media was closed, but the server session could not be released. Try ending voice again. ${normalized.message}`,
      recoverable: true,
    });
  }

  #handleServerStopped(generation: number): void {
    this.#release.markReleased();
    this.#releaseBrowserResources();
    this.#pendingTranscript.clear();
    this.#clientTranscriptDrafts.clear();
    this.#clientTranscriptDraftSequence = 0;
    this.#clientTranscriptAuthoritative = false;
    this.#activeAction = null;
    this.#controller = null;
    this.#environmentId = null;
    this.#fence = null;
    this.#sessionIdentity = null;
    this.#startInput = null;
    this.#dispatch({ type: "stopped", generation });
  }

  async #fail(generation: number, error: VoiceSessionError): Promise<void> {
    if (generation !== this.#state.generation) {
      return;
    }
    this.#dispatch({
      type: "failed",
      generation,
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    });
    try {
      await this.#releaseActiveResources();
    } catch (releaseError) {
      this.#dispatchStopFailure(generation, releaseError);
    }
  }

  async reconnect(): Promise<void> {
    if (this.#reconnectPromise) {
      return this.#reconnectPromise;
    }
    const input = this.#startInput;
    if (!input || this.#state.phase.type === "stopping" || this.#state.phase.type === "idle") {
      return;
    }
    const reconnect = (async () => {
      this.#dispatch({
        type: "reconnecting",
        generation: this.#state.generation,
        attempt: this.#state.phase.type === "reconnecting" ? this.#state.phase.attempt + 1 : 1,
      });
      await this.#stop(true);
      await this.start(input);
    })();
    this.#reconnectPromise = reconnect;
    try {
      await reconnect;
    } finally {
      if (this.#reconnectPromise === reconnect) {
        this.#reconnectPromise = null;
      }
    }
  }

  async stop(): Promise<void> {
    await this.#stop(false);
  }

  async #stop(preserveSessionIdentity: boolean): Promise<void> {
    const generation = this.#state.generation;
    if (this.#state.phase.type !== "idle") {
      this.#dispatch({ type: "stopping", generation });
    }
    try {
      await this.#releaseActiveResources();
    } catch (error) {
      this.#dispatchStopFailure(generation, error);
      return;
    }
    this.#pendingTranscript.clear();
    this.#clientTranscriptDrafts.clear();
    this.#clientTranscriptDraftSequence = 0;
    this.#clientTranscriptAuthoritative = false;
    this.#activeAction = null;
    this.#controller = null;
    this.#environmentId = null;
    if (!preserveSessionIdentity) {
      this.#sessionIdentity = null;
      this.#startInput = null;
    }
    this.#dispatch({ type: "stopped", generation });
  }
}
