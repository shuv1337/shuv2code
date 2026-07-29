export type SpeechPlaybackStatus = "idle" | "loading" | "playing";

export interface SpeechPlaybackState {
  readonly status: SpeechPlaybackStatus;
  readonly messageId: string | null;
}

interface SpeechAudio {
  currentTime: number;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  pause(): void;
  play(): Promise<void>;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface SpeechPlaybackDependencies {
  readonly requestAudio: (input: string, signal: AbortSignal) => Promise<Blob>;
  readonly createAudio: (url: string) => SpeechAudio;
  readonly createObjectUrl: (audio: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly onError: (error: Error) => void;
}

const IDLE_STATE: SpeechPlaybackState = {
  status: "idle",
  messageId: null,
};

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Text-to-speech playback failed.");
}

export class SpeechPlaybackController {
  readonly #dependencies: SpeechPlaybackDependencies;
  readonly #listeners = new Set<() => void>();
  #state = IDLE_STATE;
  #operation = 0;
  #abortController: AbortController | null = null;
  #audio: SpeechAudio | null = null;
  #audioEndedListener: EventListener | null = null;
  #audioErrorListener: EventListener | null = null;
  #objectUrl: string | null = null;

  constructor(dependencies: SpeechPlaybackDependencies) {
    this.#dependencies = dependencies;
  }

  getSnapshot = (): SpeechPlaybackState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async toggle(messageId: string, input: string): Promise<void> {
    if (this.#state.messageId === messageId && this.#state.status !== "idle") {
      this.stop();
      return;
    }

    this.stop();
    const operation = this.#operation;
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#setState({ status: "loading", messageId });

    try {
      const blob = await this.#dependencies.requestAudio(input, abortController.signal);
      if (operation !== this.#operation || abortController.signal.aborted) return;

      const objectUrl = this.#dependencies.createObjectUrl(blob);
      const audio = this.#dependencies.createAudio(objectUrl);
      this.#objectUrl = objectUrl;
      this.#audio = audio;
      this.#audioEndedListener = () => {
        if (operation === this.#operation) this.#reset(false);
      };
      this.#audioErrorListener = () => {
        if (operation !== this.#operation) return;
        this.#dependencies.onError(new Error("The generated audio could not be played."));
        this.#reset(false);
      };
      audio.addEventListener("ended", this.#audioEndedListener, { once: true });
      audio.addEventListener("error", this.#audioErrorListener, { once: true });
      await audio.play();
      if (operation !== this.#operation) return;
      this.#setState({ status: "playing", messageId });
    } catch (cause) {
      if (operation !== this.#operation || abortController.signal.aborted) return;
      this.#reset(false);
      throw asError(cause);
    }
  }

  stop(): void {
    this.#reset(true);
  }

  dispose(): void {
    this.#reset(true);
    this.#listeners.clear();
  }

  #reset(incrementOperation: boolean): void {
    if (incrementOperation) this.#operation += 1;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#audio) {
      if (this.#audioEndedListener) {
        this.#audio.removeEventListener("ended", this.#audioEndedListener);
      }
      if (this.#audioErrorListener) {
        this.#audio.removeEventListener("error", this.#audioErrorListener);
      }
      this.#audio.pause();
      this.#audio.currentTime = 0;
    }
    this.#audio = null;
    this.#audioEndedListener = null;
    this.#audioErrorListener = null;
    if (this.#objectUrl) {
      this.#dependencies.revokeObjectUrl(this.#objectUrl);
      this.#objectUrl = null;
    }
    this.#setState(IDLE_STATE);
  }

  #setState(state: SpeechPlaybackState): void {
    if (this.#state.status === state.status && this.#state.messageId === state.messageId) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
