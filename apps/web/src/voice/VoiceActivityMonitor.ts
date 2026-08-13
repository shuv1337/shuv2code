export type VoiceMediaActivity = "listening" | "user-speaking" | "assistant-speaking";

interface VoiceAudioAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void;
}

interface VoiceAudioContext {
  createAnalyser(): VoiceAudioAnalyser;
  createMediaStreamSource(stream: MediaStream): { connect(target: VoiceAudioAnalyser): unknown };
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface AudioProbe {
  readonly analyser: VoiceAudioAnalyser;
  readonly samples: Float32Array<ArrayBuffer>;
}

interface AudioSignal {
  readonly context: VoiceAudioContext;
  readonly input: AudioProbe;
  output?: AudioProbe;
}

export interface VoiceActivityMonitorDependencies {
  readonly createAudioContext?: () => VoiceAudioContext;
  readonly schedule?: (callback: () => void, delayMs: number) => number;
  readonly cancel?: (timer: number) => void;
  readonly now?: () => number;
  readonly isVisible?: () => boolean;
  readonly subscribeVisibility?: (listener: () => void) => () => void;
}

function createProbe(context: VoiceAudioContext, stream: MediaStream): AudioProbe {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  context.createMediaStreamSource(stream).connect(analyser);
  return { analyser, samples: new Float32Array(analyser.fftSize) };
}

function sampledLevel(probe: AudioProbe): number {
  probe.analyser.getFloatTimeDomainData(probe.samples);
  let sum = 0;
  for (const sample of probe.samples) sum += sample * sample;
  const rms = Math.sqrt(sum / probe.samples.length);
  return Math.min(1, Math.max(0, (rms - 0.008) * 10.5));
}

/**
 * Persistent media telemetry for the environment-owned Voice session.
 *
 * A Voice surface is only a presentation host and may remount when the right
 * panel is hidden, a thread changes, or the responsive layout changes. The
 * WebRTC streams and their analyser context therefore live here, beside the
 * app-root VoiceSessionController, until the Voice session itself ends.
 */
export class VoiceActivityMonitor {
  readonly activityLevel: { current: number } = { current: 0 };

  readonly #createAudioContext: () => VoiceAudioContext;
  readonly #scheduleTimer: (callback: () => void, delayMs: number) => number;
  readonly #cancelTimer: (timer: number) => void;
  readonly #now: () => number;
  readonly #isVisible: () => boolean;
  readonly #subscribeVisibility: (listener: () => void) => () => void;
  readonly #listeners = new Set<() => void>();
  #signal: AudioSignal | null = null;
  #pendingRemoteStream: MediaStream | null = null;
  #activity: VoiceMediaActivity = "listening";
  #remoteSpeakingUntil = 0;
  #timer: number | null = null;
  #enabled = false;
  #unsubscribeVisibility: (() => void) | null = null;

  constructor(dependencies: VoiceActivityMonitorDependencies = {}) {
    this.#createAudioContext =
      dependencies.createAudioContext ?? (() => new AudioContext() as unknown as VoiceAudioContext);
    this.#scheduleTimer =
      dependencies.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.#cancelTimer = dependencies.cancel ?? ((timer) => window.clearTimeout(timer));
    this.#now = dependencies.now ?? (() => performance.now());
    this.#isVisible = dependencies.isVisible ?? (() => document.visibilityState === "visible");
    this.#subscribeVisibility =
      dependencies.subscribeVisibility ??
      ((listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      });
  }

  get activity(): VoiceMediaActivity {
    return this.#activity;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#disposeSignal();
      return;
    }
    this.#ensureVisibilitySubscription();
    this.#schedule();
  }

  async attachMicrophone(stream: MediaStream): Promise<void> {
    const pendingRemoteStream = this.#pendingRemoteStream;
    this.#disposeSignal();
    this.#enabled = true;
    try {
      const context = this.#createAudioContext();
      const signal: AudioSignal = { context, input: createProbe(context, stream) };
      if (pendingRemoteStream !== null) {
        signal.output = createProbe(context, pendingRemoteStream);
      }
      this.#signal = signal;
      this.#ensureVisibilitySubscription();
      await context.resume();
      this.#schedule();
    } catch {
      // WebRTC owns playback. Optional visual analysis must never break it.
      this.#disposeSignal();
    }
  }

  attachRemoteAudio(stream: MediaStream): void {
    const signal = this.#signal;
    if (signal === null) {
      this.#pendingRemoteStream = stream;
      return;
    }
    try {
      signal.output = createProbe(signal.context, stream);
      void signal.context.resume().catch(() => undefined);
      this.#schedule();
    } catch {
      // Remote playback remains usable when an analyser cannot be attached.
    }
  }

  dispose(): void {
    this.#enabled = false;
    this.#disposeSignal();
    this.#unsubscribeVisibility?.();
    this.#unsubscribeVisibility = null;
    this.#listeners.clear();
  }

  #publishActivity(next: VoiceMediaActivity): void {
    if (this.#activity === next) return;
    this.#activity = next;
    for (const listener of this.#listeners) listener();
  }

  #ensureVisibilitySubscription(): void {
    if (this.#unsubscribeVisibility !== null) return;
    this.#unsubscribeVisibility = this.#subscribeVisibility(() => {
      this.#cancelScheduledSample();
      if (this.#enabled && this.#isVisible()) this.#sample();
    });
  }

  #schedule(): void {
    if (!this.#enabled || this.#signal === null || !this.#isVisible() || this.#timer !== null) {
      return;
    }
    this.#timer = this.#scheduleTimer(() => this.#sample(), 1_000 / 30);
  }

  #sample(): void {
    this.#timer = null;
    if (!this.#enabled || !this.#isVisible()) return;
    const signal = this.#signal;
    if (signal === null) return;

    const now = this.#now();
    const inputLevel = sampledLevel(signal.input);
    const outputLevel = signal.output ? sampledLevel(signal.output) : 0;
    if (outputLevel > 0.012) {
      this.#remoteSpeakingUntil = now + 420;
      this.#publishActivity("assistant-speaking");
    } else if (now < this.#remoteSpeakingUntil) {
      this.#publishActivity("assistant-speaking");
    } else if (inputLevel > 0.018) {
      this.#publishActivity("user-speaking");
    } else {
      this.#publishActivity("listening");
    }
    this.activityLevel.current =
      this.#activity === "assistant-speaking" && signal.output ? outputLevel : inputLevel;
    this.#schedule();
  }

  #cancelScheduledSample(): void {
    if (this.#timer === null) return;
    this.#cancelTimer(this.#timer);
    this.#timer = null;
  }

  #disposeSignal(): void {
    this.#cancelScheduledSample();
    const signal = this.#signal;
    this.#signal = null;
    this.#pendingRemoteStream = null;
    this.#remoteSpeakingUntil = 0;
    this.activityLevel.current = 0;
    this.#publishActivity("listening");
    if (signal !== null) void signal.context.close().catch(() => undefined);
  }
}
