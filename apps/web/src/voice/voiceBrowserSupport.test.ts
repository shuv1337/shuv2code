import { describe, expect, it } from "vite-plus/test";

import { detectVoiceBrowserSupport } from "./voiceBrowserSupport";

const noAudio = {
  AudioContext: undefined,
  AudioWorkletNode: undefined,
} as const;

describe("detectVoiceBrowserSupport", () => {
  it("rejects an insecure context before probing media or WebRTC APIs", () => {
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: false,
        mediaDevices: undefined,
        RTCPeerConnection: undefined,
        ...noAudio,
      }),
    ).toEqual({
      supported: false,
      code: "insecure-context",
      message: "Voice control requires a secure connection.",
      webrtc: false,
      pcm: false,
    });
  });

  it("reports missing microphone, peer connection, and data-channel support distinctly", () => {
    const getUserMedia = async () => ({}) as MediaStream;
    class PeerWithoutDataChannel {
      readonly unsupported = true;
    }
    class SupportedPeer {
      createDataChannel() {}
    }

    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: undefined,
        RTCPeerConnection: SupportedPeer as unknown as typeof RTCPeerConnection,
        ...noAudio,
      }),
    ).toMatchObject({ supported: false, code: "media-devices-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: undefined,
        ...noAudio,
      }),
    ).toMatchObject({ supported: false, code: "webrtc-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: PeerWithoutDataChannel as unknown as typeof RTCPeerConnection,
        ...noAudio,
      }),
    ).toMatchObject({ supported: false, code: "data-channel-unavailable" });
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: SupportedPeer as unknown as typeof RTCPeerConnection,
        ...noAudio,
      }),
    ).toEqual({ supported: true, webrtc: true, pcm: false });
  });

  it("allows PCM fallback when WebRTC is absent but AudioWorklet is present", () => {
    const getUserMedia = async () => ({}) as MediaStream;
    expect(
      detectVoiceBrowserSupport({
        isSecureContext: true,
        mediaDevices: { getUserMedia },
        RTCPeerConnection: undefined,
        AudioContext: class {} as unknown as typeof AudioContext,
        AudioWorkletNode: class {} as unknown as typeof AudioWorkletNode,
      }),
    ).toEqual({ supported: true, webrtc: false, pcm: true });
  });
});
