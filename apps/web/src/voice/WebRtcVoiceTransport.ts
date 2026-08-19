import { VoiceSessionError } from "./voiceErrors";
import { VOICE_MICROPHONE_CONSTRAINTS } from "./voiceMicrophoneAccess";

export interface WebRtcVoiceTransportConnectInput {
  readonly exchangeOffer: (offerSdp: string) => Promise<string>;
  readonly onData: (data: string) => void;
  readonly onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  readonly onMicrophoneEnded?: () => void;
  readonly onMicrophoneStream?: (stream: MediaStream) => void | Promise<void>;
  readonly onRemoteAudioStream?: (stream: MediaStream) => void;
  readonly playRemoteAudio?: boolean;
}

export interface WebRtcVoiceTransportDependencies {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createPeerConnection: () => RTCPeerConnection;
  readonly createAudioElement: () => HTMLAudioElement;
  readonly iceGatheringTimeoutMs?: number;
}

function defaultDependencies(): WebRtcVoiceTransportDependencies {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioElement: () => new Audio(),
  };
}

async function waitForIceGatheringComplete(
  peer: RTCPeerConnection,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (result: "complete" | "aborted" | "timeout") => {
      if (settled) return;
      settled = true;
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      signal.removeEventListener("abort", onAbort);
      globalThis.clearTimeout(timeout);
      if (result === "complete") {
        resolve();
      } else if (result === "aborted") {
        reject(new VoiceSessionError("transport-closed", "Voice transport was closed."));
      } else {
        reject(
          new VoiceSessionError(
            "ice-gathering-timeout",
            "Timed out while preparing the WebRTC connection.",
            true,
          ),
        );
      }
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        settle("complete");
      }
    };
    const onAbort = () => settle("aborted");
    const timeout = globalThis.setTimeout(() => settle("timeout"), timeoutMs);
    peer.addEventListener("icegatheringstatechange", onStateChange);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      settle("aborted");
    }
  });
}

export class WebRtcVoiceTransport {
  readonly #dependencies: WebRtcVoiceTransportDependencies;
  #peer: RTCPeerConnection | null = null;
  #dataChannel: RTCDataChannel | null = null;
  #microphone: MediaStream | null = null;
  #remoteAudio: HTMLAudioElement | null = null;
  #connectAbort: AbortController | null = null;
  #closed = false;

  constructor(dependencies: WebRtcVoiceTransportDependencies = defaultDependencies()) {
    this.#dependencies = dependencies;
  }

  get muted(): boolean {
    return this.#microphone?.getAudioTracks().every((track) => !track.enabled) ?? false;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async connect(
    input: WebRtcVoiceTransportConnectInput,
    microphoneStream?: MediaStream,
  ): Promise<void> {
    if (this.#peer !== null) {
      throw new VoiceSessionError("transport-already-started", "Voice transport already started.");
    }
    this.#closed = false;
    const connectAbort = new AbortController();
    this.#connectAbort = connectAbort;
    try {
      const microphone =
        microphoneStream ?? (await this.#dependencies.getUserMedia(VOICE_MICROPHONE_CONSTRAINTS));
      if (this.#closed) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      this.#microphone = microphone;
      await input.onMicrophoneStream?.(microphone);
      if (this.#closed) return;

      const peer = this.#dependencies.createPeerConnection();
      const remoteAudio = this.#dependencies.createAudioElement();
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute("aria-hidden", "true");
      remoteAudio.style.display = "none";
      const dataChannel = peer.createDataChannel("oai-events");

      this.#peer = peer;
      this.#dataChannel = dataChannel;
      this.#remoteAudio = remoteAudio;

      for (const track of microphone.getAudioTracks()) {
        peer.addTrack(track, microphone);
        track.addEventListener("ended", () => {
          if (!this.#closed) {
            input.onMicrophoneEnded?.();
          }
        });
      }
      dataChannel.addEventListener("message", (event) => {
        if (!this.#closed && typeof event.data === "string") {
          input.onData(event.data);
        }
      });
      peer.addEventListener("connectionstatechange", () => {
        input.onConnectionStateChange?.(peer.connectionState);
      });
      peer.addEventListener("track", (event) => {
        if (input.playRemoteAudio === false) return;
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        input.onRemoteAudioStream?.(remoteStream);
        remoteAudio.srcObject = remoteStream;
        void remoteAudio.play().catch((error: unknown) => {
          input.onData(
            JSON.stringify({
              type: "client.playback-error",
              message:
                error instanceof Error ? error.message : "Remote audio playback was blocked.",
            }),
          );
        });
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(
        peer,
        connectAbort.signal,
        this.#dependencies.iceGatheringTimeoutMs ?? 10_000,
      );
      if (this.#closed) return;
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) {
        throw new VoiceSessionError(
          "offer-missing",
          "The browser did not produce a WebRTC offer.",
          true,
        );
      }
      const answerSdp = await input.exchangeOffer(offerSdp);
      if (this.#closed) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (error) {
      this.close();
      throw error;
    } finally {
      if (this.#connectAbort === connectAbort) {
        this.#connectAbort = null;
      }
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.#microphone?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connectAbort?.abort();
    this.#connectAbort = null;
    this.#dataChannel?.close();
    this.#dataChannel = null;
    this.#peer?.close();
    this.#peer = null;
    for (const track of this.#microphone?.getTracks() ?? []) {
      track.stop();
    }
    this.#microphone = null;
    if (this.#remoteAudio) {
      this.#remoteAudio.pause();
      this.#remoteAudio.srcObject = null;
      this.#remoteAudio.removeAttribute("src");
    }
    this.#remoteAudio = null;
  }
}
