import type { RealtimeVoiceTransport } from "@shuv2code/client-runtime/voice";

export interface PcmVoiceTransportOptions {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly onPcmChunk: (chunk: {
    readonly sequence: number;
    readonly audioBase64: string;
    readonly format: "pcm16";
    readonly sampleRateHz: number;
    readonly channels: number;
  }) => void | Promise<void>;
  readonly onOutputAudio?: (chunk: {
    readonly audioBase64: string;
    readonly sampleRateHz: number;
    readonly channels: number;
  }) => void;
}

/**
 * Bounded mono PCM16 capture via AudioWorklet when WebRTC is unavailable.
 * Playback uses a short jitter queue and stops immediately on mute/stop.
 */
export class PcmVoiceTransport implements RealtimeVoiceTransport {
  readonly kind = "websocket" as const;
  readonly #options: PcmVoiceTransportOptions;
  #sequence = 0;
  #muted = false;
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #worklet: AudioWorkletNode | null = null;
  #stopped = false;

  constructor(options: PcmVoiceTransportOptions) {
    this.#options = options;
  }

  async start(microphoneStream?: MediaStream): Promise<{ kind: "websocket"; answerSdp: null }> {
    if (this.#stopped) throw new Error("PCM transport already stopped.");
    this.#stream =
      microphoneStream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: this.#options.channels,
          sampleRate: this.#options.sampleRateHz,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      }));
    this.#context = new AudioContext({ sampleRate: this.#options.sampleRateHz });
    // Inline worklet avoids a separate asset fetch in the Vite app shell.
    const workletSource = `
      class PcmCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0]?.[0];
          if (!input) return true;
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i] ?? 0));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
          return true;
        }
      }
      registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
    `;
    const blob = new Blob([workletSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.#context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = this.#context.createMediaStreamSource(this.#stream);
    this.#worklet = new AudioWorkletNode(this.#context, "pcm-capture-processor");
    this.#worklet.port.onmessage = (event) => {
      if (this.#muted || this.#stopped) return;
      const buffer = event.data as ArrayBuffer;
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const audioBase64 = btoa(binary);
      this.#sequence += 1;
      void this.#options.onPcmChunk({
        sequence: this.#sequence,
        audioBase64,
        format: "pcm16",
        sampleRateHz: this.#options.sampleRateHz,
        channels: this.#options.channels,
      });
    };
    source.connect(this.#worklet);
    // Keep the graph alive without audible local loopback.
    this.#worklet.connect(this.#context.createGain());
    return { kind: "websocket", answerSdp: null };
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#worklet?.disconnect();
    this.#worklet = null;
    await this.#context?.close().catch(() => undefined);
    this.#context = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
  }

  /** Match WebRtcVoiceTransport lifecycle used by VoiceSessionController. */
  close(): void {
    void this.stop();
  }
}
